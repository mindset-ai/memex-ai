// t-1 voice WS proxy — REAL-SOCKET integration test (dec-9 / ac-32). Boots the
// actual @hono/node-server with createNodeWebSocket + injectWebSocket, then drives
// it with a real `ws` client. This closes the gap the unit tests (voice.test.ts)
// leave: it proves the WebSocket handshake + upgrade actually work, that the
// connect-query token is read through the real handshake (std-7 close-1008 on
// deny), that binary mic frames arrive and route to STT, and that transcripts +
// TTS audio flow back over the SAME socket (ac-6 / ac-7 / ac-32). The provider is
// the deterministic fake (MEMEX_ELEVENLABS_FAKE=1); the auth deps are mocked so
// no DB or real JWT is needed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock("../services/auth-jwt.js", () => ({
  verifySessionToken: vi.fn(),
  InvalidTokenError: class InvalidTokenError extends Error {},
}));
vi.mock("../services/users.js", () => ({ getUserById: vi.fn() }));
vi.mock("../mcp/auth.js", () => ({ canReadMemex: vi.fn() }));

import { verifySessionToken, InvalidTokenError } from "../services/auth-jwt.js";
import { getUserById } from "../services/users.js";
import { canReadMemex } from "../mcp/auth.js";
import { createVoiceRouter } from "./voice.js";
import { enqueueFakeTranscript, clearFakeVoiceQueue } from "../agent/elevenlabs-fake.js";
import { __resetVoiceProviderForTests } from "../agent/elevenlabs-client.js";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-6";
const AC7 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-7";
const AC32 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-32";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error("waitUntil timed out");
}

interface WireMsg {
  type: string;
  text?: string;
  isFinal?: boolean;
  requestId?: string;
  audio?: string;
  alignment?: { chars: string[]; charStartMs: number[]; charDurationMs: number[] };
}

function buildApp() {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // Stand in for memexResolver: the WS auth only needs c.get("memex") truthy
  // (membership/read is decided by the mocked canReadMemex).
  app.use("*", async (c, next) => {
    c.set("memex" as never, { id: "m1" } as never);
    await next();
  });
  app.route("/voice", createVoiceRouter(upgradeWebSocket));
  return { app, injectWebSocket };
}

describe("voice WS proxy — real socket (ac-32 transport)", () => {
  let server: ReturnType<typeof serve>;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
    clearFakeVoiceQueue();

    // token "good" → valid; anything else → invalid.
    vi.mocked(verifySessionToken).mockImplementation((t: string) => {
      if (t === "good") return { sub: "u1", iat: 0, exp: 0 };
      throw new InvalidTokenError("bad");
    });
    vi.mocked(getUserById).mockResolvedValue({ id: "u1", status: "active" } as never);
    vi.mocked(canReadMemex).mockResolvedValue(true);

    const built = buildApp();
    server = serve({ fetch: built.app.fetch, port: 0 });
    built.injectWebSocket(server);
    await new Promise((r) => setImmediate(r));
    port = (server as unknown as { address: () => AddressInfo }).address().port;
  });

  afterEach(async () => {
    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    clients.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(token?: string) {
    const qs = token === undefined ? "" : `?token=${token}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/session${qs}`);
    clients.push(ws);
    const msgs: WireMsg[] = [];
    let closeCode: number | null = null;
    ws.on("message", (data: Buffer) => {
      try {
        msgs.push(JSON.parse(data.toString()) as WireMsg);
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on("close", (code: number) => {
      closeCode = code;
    });
    ws.on("error", () => {
      /* close handler records the code; swallow the error event */
    });
    return { ws, msgs, getCloseCode: () => closeCode };
  }

  it("carries the full STT + TTS loop over one authenticated socket", async () => {
    enqueueFakeTranscript({
      events: [
        { text: "how", isFinal: false },
        { text: "how do I", isFinal: false },
        { text: "how do I add a decision", isFinal: true },
      ],
    });
    const c = open("good");
    await waitUntil(() => c.msgs.some((m) => m.type === "ready"));

    // STT leg: a binary mic frame travels over the real wire → server → fake STT.
    c.ws.send(JSON.stringify({ type: "start_listening" }));
    c.ws.send(Buffer.from([1, 2, 3]));
    await sleep(30);
    c.ws.send(Buffer.from([4, 5, 6]));
    await sleep(30);
    c.ws.send(JSON.stringify({ type: "end_utterance" }));
    await waitUntil(() => c.msgs.some((m) => m.type === "transcript" && m.isFinal === true));

    // TTS leg on the SAME socket.
    c.ws.send(JSON.stringify({ type: "speak", requestId: "r1", text: "sure thing" }));
    await waitUntil(() =>
      c.msgs.some((m) => m.type === "audio" && m.isFinal === true && m.requestId === "r1"),
    );

    const transcripts = c.msgs.filter((m) => m.type === "transcript");
    const audio = c.msgs.filter((m) => m.type === "audio");
    expect(transcripts.some((t) => t.isFinal === false)).toBe(true); // interim mid-utterance (ac-6)
    expect(transcripts.some((t) => t.isFinal === true)).toBe(true);
    expect(audio.length).toBeGreaterThanOrEqual(2); // streamed chunks, not one blob (ac-7)
    expect(audio[0].alignment?.chars.length).toBeGreaterThan(0); // alignment over the wire (dec-8)

    tagAc(AC6);
    tagAc(AC7);
    tagAc(AC32);
  });

  it("closes 1008 (no 'ready') when the connect token is missing or invalid (std-7)", async () => {
    const missing = open(); // no ?token
    await waitUntil(() => missing.getCloseCode() !== null);
    expect(missing.getCloseCode()).toBe(1008);
    expect(missing.msgs.some((m) => m.type === "ready")).toBe(false);

    const bad = open("nope"); // invalid token
    await waitUntil(() => bad.getCloseCode() !== null);
    expect(bad.getCloseCode()).toBe(1008);
    expect(bad.msgs.some((m) => m.type === "ready")).toBe(false);

    tagAc(AC32);
  });
});
