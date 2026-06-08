// spec-190 — empirically probe the LIVE ElevenLabs concurrency ceilings for the
// current plan (the two numbers the docs don't publish cleanly: STT streaming
// concurrency, and whether burst applies to the raw API). Measures simultaneity,
// not volume — payloads are deliberately tiny, so it costs a negligible slice of
// the credit allotment (~hundreds of credits, <1% of Creator's 100k).
//
// Usage:  pnpm --filter @memex/server tsx scripts/probe-elevenlabs-limits.ts
// Needs:  ELEVENLABS_API_KEY in packages/server/.env (real key, not the fake).
//
// Method: fire K connections near-simultaneously into each pool (TTS, STT),
// hold them open briefly so they genuinely overlap, then classify each as
// accepted vs rejected. The count that stays open ≈ the concurrency limit; the
// 429 body usually states it outright. TTS and STT are probed separately (they
// are SEPARATE concurrency pools) with a drain gap between, and a small stagger
// avoids tripping a transient rate-limit.

import { WebSocket } from "ws";

const EL_BASE = "wss://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const TTS_MODEL = "eleven_flash_v2_5";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2_realtime";

const K = 10; // ramp ceiling — past Creator's documented TTS=5, enough to see burst
const HOLD_MS = 3000; // keep all K open this long so they truly overlap
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Verdict {
  i: number;
  accepted: boolean;
  reason: string;
  body?: string;
}

function parseLimit(bodies: string[]): string {
  for (const b of bodies) {
    const m =
      /(\d+)\s*concurrent/i.exec(b) ??
      /maximum of\s*(\d+)/i.exec(b) ??
      /limit[^0-9]{0,20}(\d+)/i.exec(b);
    if (m) return m[1];
  }
  return "not stated in error body";
}

/** One probe connection. Resolves with a verdict after the hold window (or sooner
 *  on a definitive rejection). `onOpen` lets each pool send its slot-occupying
 *  payload. We hold the socket open (no graceful finish) so the slot stays busy. */
function probeConn(
  i: number,
  url: string,
  onOpen: (ws: WebSocket) => void,
): { done: Promise<Verdict>; close: () => void } {
  const ws = new WebSocket(url, { headers: { "xi-api-key": KEY as string } });
  let settled = false;
  let opened = false;
  let gotData = false;
  const bodies: string[] = [];
  let resolve!: (v: Verdict) => void;
  const done = new Promise<Verdict>((r) => (resolve = r));
  const finish = (accepted: boolean, reason: string): void => {
    if (settled) return;
    settled = true;
    resolve({ i, accepted, reason, body: bodies[0] });
  };

  ws.on("open", () => {
    opened = true;
    try {
      onOpen(ws);
    } catch {
      /* ignore */
    }
  });
  // ws emits 'unexpected-response' for a non-101 handshake (429/403 etc).
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (d: Buffer) => (body += d.toString()));
    res.on("end", () => {
      bodies.push(`HTTP ${res.statusCode}: ${body}`);
      finish(false, `handshake ${res.statusCode}`);
    });
  });
  ws.on("message", (raw: Buffer) => {
    const s = raw.toString();
    if (/concurren|too many|limit|quota|exceeded|usage/i.test(s) && /error|detail|status/i.test(s)) {
      bodies.push(s.slice(0, 300));
      finish(false, "error frame (concurrency/limit)");
      return;
    }
    gotData = true; // real audio / transcript / control frame → the slot is live
  });
  ws.on("close", (code: number) => {
    if (!opened) finish(false, `closed before open (code ${code})`);
    else if (code === 1008 || code === 1011 || code >= 4000) finish(false, `policy close (code ${code})`);
    // otherwise leave for the hold-window verdict
  });
  ws.on("error", () => {
    if (!opened) finish(false, "connection error");
  });

  // Hold-window verdict: if it opened and wasn't rejected, it's holding a slot.
  void sleep(HOLD_MS).then(() => finish(opened, opened ? (gotData ? "open + active" : "open") : "never opened"));

  return {
    done,
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

async function probePool(
  label: string,
  url: string,
  onOpen: (ws: WebSocket) => void,
): Promise<void> {
  console.log(`\n── ${label} — firing ${K} concurrent connections ──`);
  const conns: Array<{ done: Promise<Verdict>; close: () => void }> = [];
  // Tight loop, tiny stagger (20ms) — near-simultaneous but gentle on rate limits.
  for (let i = 0; i < K; i++) {
    conns.push(probeConn(i, url, onOpen));
    await sleep(20);
  }
  const verdicts = await Promise.all(conns.map((c) => c.done));
  conns.forEach((c) => c.close());

  const accepted = verdicts.filter((v) => v.accepted);
  const rejected = verdicts.filter((v) => !v.accepted);
  const bodies = rejected.map((v) => v.body ?? "").filter(Boolean);

  console.log(`  accepted (held a slot): ${accepted.length}`);
  console.log(`  rejected:               ${rejected.length}`);
  if (rejected.length) {
    const reasons = [...new Set(rejected.map((v) => v.reason))];
    console.log(`  rejection reasons:      ${reasons.join("; ")}`);
    console.log(`  limit stated in body:   ${parseLimit(bodies)}`);
    const sample = bodies[0];
    if (sample) console.log(`  sample body:            ${sample.slice(0, 200)}`);
    console.log(`  → ${label} concurrency ceiling ≈ ${accepted.length} (burst? accepted > documented = yes)`);
  } else {
    console.log(`  → all ${K} accepted — ceiling is ≥ ${K} on this plan (raise K to find it).`);
  }
}

async function main(): Promise<void> {
  if (!KEY || process.env.MEMEX_ELEVENLABS_FAKE === "1") {
    console.error("✗ Set a real ELEVENLABS_API_KEY in packages/server/.env (and unset MEMEX_ELEVENLABS_FAKE).");
    process.exit(2);
  }
  console.log(`Probing ElevenLabs concurrency (K=${K}, hold=${HOLD_MS}ms). Payloads tiny — negligible credit use.`);

  // TTS pool: stream-input WS. Occupy a slot by opening + sending settings and a
  // SHORT text, without the empty-string flush (keeps the input side open).
  await probePool(
    "TTS (text-to-speech stream-input)",
    `${EL_BASE}/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${TTS_MODEL}&output_format=mp3_44100_128`,
    (ws) => {
      ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
      ws.send(JSON.stringify({ text: "Probe." })); // ~6 chars; no flush → slot held open
    },
  );

  console.log("\n…draining TTS slots before STT probe…");
  await sleep(5000);

  // STT pool: realtime WS. Occupy a slot by opening + pushing a short silence chunk.
  await probePool(
    "STT (speech-to-text realtime)",
    `${EL_BASE}/v1/speech-to-text/realtime?model_id=${STT_MODEL}&audio_format=pcm_16000&commit_strategy=manual`,
    (ws) => {
      const silence = Buffer.alloc(16000 * 0.3 * 2); // 0.3s of 16kHz 16-bit silence
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: silence.toString("base64") }));
    },
  );

  console.log("\nDone. (Ceilings are for the CURRENT plan only — re-run after any upgrade.)");
  process.exit(0);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});
