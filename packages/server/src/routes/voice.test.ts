// t-1 voice WS proxy — unit tests against the deterministic fake provider
// (MEMEX_ELEVENLABS_FAKE=1). No real socket or ElevenLabs key needed: the proxy
// logic lives in VoiceSession (driven by a recording VoiceSink) and the auth
// logic in authenticateVoiceConnection (deps mocked). Covers ac-6 (streaming STT
// in, key never client-side), ac-7 (streaming TTS out, playback before
// completion), ac-32 (single authenticated socket carries the whole loop; std-7
// uniform deny; barge-in/teardown).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import type { Context } from "hono";

// Mock the auth dependencies so authenticateVoiceConnection is exercised without
// real JWT verification or DB access.
vi.mock("../services/auth-jwt.js", () => ({
  verifySessionToken: vi.fn(),
  InvalidTokenError: class InvalidTokenError extends Error {},
}));
vi.mock("../services/users.js", () => ({ getUserById: vi.fn() }));
vi.mock("../mcp/auth.js", () => ({ canReadMemex: vi.fn() }));

import { verifySessionToken, InvalidTokenError } from "../services/auth-jwt.js";
import { getUserById } from "../services/users.js";
import { canReadMemex } from "../mcp/auth.js";
import {
  VoiceSession,
  authenticateVoiceConnection,
  type VoiceSink,
  type VoiceAuthResult,
} from "./voice.js";
import {
  isVoiceConfigured,
  resolveVoiceProvider,
  VoiceNotConfiguredError,
  __resetVoiceProviderForTests,
} from "../agent/elevenlabs-client.js";
import { enqueueFakeTranscript, clearFakeVoiceQueue } from "../agent/elevenlabs-fake.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-190";
const AC6 = `${SPEC}/acs/ac-6`;
const AC7 = `${SPEC}/acs/ac-7`;
const AC32 = `${SPEC}/acs/ac-32`;

const OK_AUTH: VoiceAuthResult = { ok: true, userId: "u1", closeCode: 1000, closeReason: "ok" };

interface SentMsg {
  type: string;
  text?: string;
  isFinal?: boolean;
  requestId?: string;
  audio?: string;
  alignment?: { chars: string[]; charStartMs: number[]; charDurationMs: number[] };
  message?: string;
}

function recordingSink() {
  const sent: SentMsg[] = [];
  const closed: { code: number; reason: string }[] = [];
  const sink: VoiceSink = {
    send: (d) => sent.push(JSON.parse(d) as SentMsg),
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { sink, sent, closed };
}

// Let queued transcript/audio events drain through the async pumps.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

function restoreEnv(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

const ORIG_FAKE = process.env.MEMEX_ELEVENLABS_FAKE;
const ORIG_KEY = process.env.ELEVENLABS_API_KEY;

afterEach(() => {
  restoreEnv("MEMEX_ELEVENLABS_FAKE", ORIG_FAKE);
  restoreEnv("ELEVENLABS_API_KEY", ORIG_KEY);
  __resetVoiceProviderForTests();
  clearFakeVoiceQueue();
});

describe("voice provider resolution (dec-2 / dec-9)", () => {
  it("throws VoiceNotConfiguredError when neither a key nor the fake is set", () => {
    delete process.env.MEMEX_ELEVENLABS_FAKE;
    delete process.env.ELEVENLABS_API_KEY;
    __resetVoiceProviderForTests();
    expect(isVoiceConfigured()).toBe(false);
    expect(() => resolveVoiceProvider()).toThrow(VoiceNotConfiguredError);
  });

  it("resolves the deterministic fake under MEMEX_ELEVENLABS_FAKE=1", () => {
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
    expect(isVoiceConfigured()).toBe(true);
    expect(resolveVoiceProvider().name).toBe("elevenlabs-fake");
  });
});

describe("ac-6 — streaming STT through the server", () => {
  beforeEach(() => {
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
    clearFakeVoiceQueue();
  });

  it("emits interim transcripts while the user speaks, then a final on end-of-speech", async () => {
    enqueueFakeTranscript({
      events: [
        { text: "how", isFinal: false },
        { text: "how do", isFinal: false },
        { text: "how do I resolve a decision", isFinal: true },
      ],
    });
    const { sink, sent } = recordingSink();
    const s = new VoiceSession(sink, { configured: true, auth: OK_AUTH });
    s.open();
    s.handleText(JSON.stringify({ type: "start_listening" }));
    // Mic audio frames arrive (browser → server → ElevenLabs); the API key never
    // appears on this path — only the server-side provider holds it (ac-6).
    s.handleBinary(new Uint8Array([1, 2, 3]));
    s.handleBinary(new Uint8Array([4, 5, 6]));
    await flush();
    s.handleText(JSON.stringify({ type: "end_utterance" }));
    await flush();

    const transcripts = sent.filter((m) => m.type === "transcript");
    const interims = transcripts.filter((t) => !t.isFinal);
    const finals = transcripts.filter((t) => t.isFinal);
    expect(interims.length).toBeGreaterThanOrEqual(2); // arrived mid-utterance
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toContain("resolve a decision");
    expect(transcripts[transcripts.length - 1].isFinal).toBe(true); // final came last
    tagAc(AC6);
  });
});

describe("ac-7 — streaming TTS through the server", () => {
  beforeEach(() => {
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
  });

  it("streams audio chunks with char-alignment, beginning before synthesis finishes", async () => {
    const { sink, sent } = recordingSink();
    const s = new VoiceSession(sink, { configured: true, auth: OK_AUTH });
    s.open();
    s.handleText(JSON.stringify({ type: "speak", requestId: "r1", text: "hello there friend" }));
    await flush();

    const audio = sent.filter((m) => m.type === "audio" && m.requestId === "r1");
    // One chunk per word → the client can start playback on chunk 0, before the
    // final chunk arrives (ac-7) — not a single end-of-synthesis blob.
    expect(audio.length).toBe(3);
    expect(audio[0].isFinal).toBe(false);
    expect(audio[audio.length - 1].isFinal).toBe(true);
    // Char-alignment present (dec-8 truncation depends on it).
    expect(audio[0].alignment?.chars.length).toBeGreaterThan(0);
    expect(audio[0].alignment?.charStartMs.length).toBe(audio[0].alignment?.chars.length);
    // Audio is base64-encoded bytes; the fake encodes the word so we can round-trip.
    expect(typeof audio[0].audio).toBe("string");
    expect(Buffer.from(audio[0].audio ?? "", "base64").toString()).toContain("hello");
    tagAc(AC7);
  });
});

describe("ac-32 — one authenticated socket carries the whole loop", () => {
  describe("authenticateVoiceConnection (std-7 uniform deny)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    function fakeCtx(opts: { token?: string; memex?: { id: string } | null }): Context {
      return {
        req: { query: (k: string) => (k === "token" ? opts.token : undefined) },
        get: (k: string) => (k === "memex" ? opts.memex ?? null : undefined),
      } as unknown as Context;
    }

    it("denies every failure mode identically (close 1008, no detail)", async () => {
      // 1) missing token
      expect(await authenticateVoiceConnection(fakeCtx({}))).toMatchObject({
        ok: false,
        closeCode: 1008,
      });

      // 2) invalid token
      vi.mocked(verifySessionToken).mockImplementation(() => {
        throw new InvalidTokenError("bad");
      });
      expect(
        await authenticateVoiceConnection(fakeCtx({ token: "x", memex: { id: "m1" } })),
      ).toMatchObject({ ok: false, closeCode: 1008, closeReason: "unauthorized" });

      // 3) valid token, user gone
      vi.mocked(verifySessionToken).mockReturnValue({ sub: "u1" } as never);
      vi.mocked(getUserById).mockResolvedValue(undefined as never);
      expect(
        await authenticateVoiceConnection(fakeCtx({ token: "x", memex: { id: "m1" } })),
      ).toMatchObject({ ok: false, closeCode: 1008 });

      // 4) valid user, memex not resolved
      vi.mocked(getUserById).mockResolvedValue({ id: "u1", status: "active" } as never);
      expect(
        await authenticateVoiceConnection(fakeCtx({ token: "x", memex: null })),
      ).toMatchObject({ ok: false, closeCode: 1008 });

      // 5) valid user + memex, but no read access → same deny as not-found (std-7)
      vi.mocked(canReadMemex).mockResolvedValue(false);
      expect(
        await authenticateVoiceConnection(fakeCtx({ token: "x", memex: { id: "m1" } })),
      ).toMatchObject({ ok: false, closeCode: 1008, closeReason: "unauthorized" });
      tagAc(AC32);
    });

    it("allows a valid token for a readable memex", async () => {
      vi.mocked(verifySessionToken).mockReturnValue({ sub: "u1" } as never);
      vi.mocked(getUserById).mockResolvedValue({ id: "u1", status: "active" } as never);
      vi.mocked(canReadMemex).mockResolvedValue(true);
      const r = await authenticateVoiceConnection(
        fakeCtx({ token: "good", memex: { id: "m1" } }),
      );
      expect(r.ok).toBe(true);
      expect(r.userId).toBe("u1");
      tagAc(AC32);
    });
  });

  describe("VoiceSession lifecycle", () => {
    beforeEach(() => {
      process.env.MEMEX_ELEVENLABS_FAKE = "1";
      __resetVoiceProviderForTests();
      clearFakeVoiceQueue();
    });

    it("carries STT-in and TTS-out on the same session, idempotent teardown", async () => {
      enqueueFakeTranscript({
        events: [
          { text: "hi", isFinal: false },
          { text: "hi there", isFinal: true },
        ],
      });
      const { sink, sent } = recordingSink();
      const s = new VoiceSession(sink, { configured: true, auth: OK_AUTH });
      s.open();
      expect(sent[0]).toEqual({ type: "ready" });

      s.handleText(JSON.stringify({ type: "start_listening" }));
      s.handleBinary(new Uint8Array([1]));
      s.handleText(JSON.stringify({ type: "end_utterance" }));
      s.handleText(JSON.stringify({ type: "speak", requestId: "r1", text: "okay sure" }));
      await flush();

      expect(sent.some((m) => m.type === "transcript")).toBe(true);
      expect(sent.some((m) => m.type === "audio")).toBe(true);
      // Teardown is safe + idempotent.
      s.teardown();
      s.teardown();
      tagAc(AC32);
    });

    it("closes 1011 when voice is unconfigured and 1008 when unauthorized", () => {
      const unconfigured = recordingSink();
      new VoiceSession(unconfigured.sink, { configured: false, auth: OK_AUTH }).open();
      expect(unconfigured.closed[0]).toMatchObject({ code: 1011 });
      expect(unconfigured.sent).toHaveLength(0); // never sent "ready"

      const denied = recordingSink();
      new VoiceSession(denied.sink, {
        configured: true,
        auth: { ok: false, closeCode: 1008, closeReason: "unauthorized" },
      }).open();
      expect(denied.closed[0]).toMatchObject({ code: 1008 });
      tagAc(AC32);
    });

    it("barge-in abort halts in-flight TTS before all chunks are synthesized", async () => {
      const { sink, sent } = recordingSink();
      const s = new VoiceSession(sink, { configured: true, auth: OK_AUTH });
      s.open();
      s.handleText(
        JSON.stringify({ type: "speak", requestId: "r1", text: "one two three four five six seven eight" }),
      );
      // Abort immediately (the synth loop hasn't iterated yet).
      s.handleText(JSON.stringify({ type: "abort", requestId: "r1" }));
      await flush();
      const audio = sent.filter((m) => m.type === "audio");
      expect(audio.length).toBeLessThan(8); // cut short by the abort
      tagAc(AC32);
    });
  });
});
