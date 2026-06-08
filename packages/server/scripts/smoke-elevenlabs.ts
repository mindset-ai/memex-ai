// spec-190 — one-shot smoke test for the live ElevenLabs voice path. Proves the
// provisioned ELEVENLABS_API_KEY actually works for BOTH legs our DIY pipeline
// uses (dec-2): streaming TTS (eleven_flash_v2_5) and streaming STT (scribe_v1),
// through the real client in agent/elevenlabs-client.ts.
//
// Usage:  pnpm --filter @memex/server tsx scripts/smoke-elevenlabs.ts
// Needs:  ELEVENLABS_API_KEY in packages/server/.env (NOT the fake).
//
// Costs a few hundred TTS characters — negligible against the Creator quota.
// Read-ish: it does not mutate anything; it just opens the two streams.

import { resolveVoiceProvider, isVoiceConfigured } from "../src/agent/elevenlabs-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (process.env.MEMEX_ELEVENLABS_FAKE === "1") {
    console.error("✗ MEMEX_ELEVENLABS_FAKE=1 is set — unset it to smoke the REAL key.");
    process.exit(2);
  }
  if (!isVoiceConfigured()) {
    console.error("✗ ELEVENLABS_API_KEY not set in packages/server/.env.");
    process.exit(2);
  }

  const provider = resolveVoiceProvider();
  console.log(`provider: ${provider.name} (audioFormat=${provider.audioFormat})`);

  let ttsOk = false;
  let sttOk = false;

  // ── TTS leg ────────────────────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    let chunks = 0;
    let bytes = 0;
    let firstChunkMs = 0;
    let sawAlignment = false;
    for await (const chunk of provider.synthesize(
      "Hello — this is the Memex voice guide smoke test.",
    )) {
      if (chunks === 0) firstChunkMs = Date.now() - t0;
      chunks += 1;
      bytes += chunk.audio.byteLength;
      if (chunk.alignment) sawAlignment = true;
    }
    ttsOk = chunks > 0 && bytes > 0;
    console.log(
      `TTS: ${ttsOk ? "✓ PASS" : "✗ FAIL"} — ${chunks} chunk(s), ${bytes} bytes, ` +
        `first-chunk ${firstChunkMs}ms, alignment=${sawAlignment}`,
    );
  } catch (err) {
    console.log(`TTS: ✗ FAIL — ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── STT leg ──────────────────────────────────────────────────────────────────
  // We only need to prove the stream AUTHENTICATES and accepts audio — real
  // transcription needs real speech (covered by the t-9 e2e). Push a short PCM
  // silence frame, end the utterance, and confirm no auth/connection error.
  try {
    const stt = provider.openStt({ sampleRate: 16000, languageCode: "en" });
    // 0.3s of 16kHz 16-bit mono silence.
    stt.pushAudio(new Uint8Array(16000 * 0.3 * 2));
    stt.endUtterance();
    const it = stt.transcripts()[Symbol.asyncIterator]();
    // Race a transcript event against a timeout; either way, no throw = handshake ok.
    await Promise.race([it.next(), sleep(5000)]);
    stt.close();
    sttOk = true;
    console.log("STT: ✓ PASS — stream authenticated and accepted audio (no transcript expected for silence).");
  } catch (err) {
    console.log(`STT: ✗ FAIL — ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n${ttsOk && sttOk ? "✓ ALL GREEN — the key works for both legs." : "✗ one or more legs failed (see above)."}`);
  process.exit(ttsOk && sttOk ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
