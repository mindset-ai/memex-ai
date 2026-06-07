// Voice WebSocket proxy (spec-190 t-1 / dec-2 / dec-9). One WebSocket per voice
// session carries the whole audio loop (ac-32): mic audio frames upstream →
// ElevenLabs streaming STT; the guide's synthesized speech (TTS audio chunks +
// char-alignment) downstream. The ElevenLabs API key lives only behind
// resolveVoiceProvider() on the server — it never reaches the browser (ac-6).
// The LLM text proxy stays on SSE (routes/llm.ts, dec-2); WebSocket is added
// only for the audio leg.
//
// Auth: browsers can't set Authorization headers on a WS handshake, so the
// session token rides the connect query (?token=). We validate it exactly like
// sessionMiddleware (verifySessionToken → getUserById) and gate on canReadMemex
// against the path-resolved memex. On ANY failure the socket is closed with 1008
// and nothing about the reason leaks (std-7), mirroring the 404 posture.
//
// Wire protocol (browser ↔ server). Control frames are JSON text; mic audio is
// sent as binary frames:
//   client → server: binary mic-audio frames;
//                     {type:"start_listening"} | {type:"end_utterance"} |
//                     {type:"speak", requestId, text} | {type:"abort", requestId}
//   server → client: {type:"ready"} |
//                     {type:"transcript", text, isFinal} |
//                     {type:"audio", requestId, audio(base64), alignment?, isFinal} |
//                     {type:"error", requestId?, message}
// The graph (t-3) lives client-side and drives "speak"/"abort"; t-1 delivers the
// proxy plumbing both sides ride.
//
// Testability: the per-connection logic lives in VoiceSession, written against a
// tiny VoiceSink (send/close) rather than a live WSContext, so the proxy can be
// exercised deterministically with the fake provider and no real socket.

import { Hono } from "hono";
import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import { streamSSE } from "hono/streaming";
import { z } from "zod/v4";
import type { createNodeWebSocket } from "@hono/node-ws";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { verifySessionToken, InvalidTokenError } from "../services/auth-jwt.js";
import { getUserById } from "../services/users.js";
import { canReadMemex } from "../mcp/auth.js";
import {
  isVoiceConfigured,
  resolveVoiceProvider,
  type SttSession,
} from "../agent/elevenlabs-client.js";
import { getAnthropicClient, LlmNotConfiguredError } from "../agent/anthropic-client.js";
import { buildGuideSystemBlocks } from "../agent/voice/guide-prompt.js";
import { GUIDE_TOOLS } from "@memex/shared";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import type { SessionEnv } from "../middleware/session.js";

// Same model as the main agent proxy (routes/llm.ts). Voice replies are short
// (max_tokens kept low) and TTS streams from the first token, so latency rides
// on time-to-first-token, not total length.
const GUIDE_MODEL = "claude-sonnet-4-5-20250929";

const guideChatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.any() })),
  screenKey: z.string().nullable().optional(),
  screenRegistry: z
    .array(z.object({ id: z.string(), description: z.string() }))
    .optional(),
  guideContext: z.array(z.string()).optional(),
});

type Env = MemexResolverEnv & SessionEnv;
type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];

export interface VoiceAuthResult {
  ok: boolean;
  userId?: string;
  /** WS close code to apply when !ok (1008 policy-violation by default). */
  closeCode: number;
  closeReason: string;
}

const DENY: VoiceAuthResult = { ok: false, closeCode: 1008, closeReason: "unauthorized" };

/**
 * Resolve and authorize a voice WS connection from the connect-query token and
 * the path-resolved memex. Pure enough to unit-test in isolation. Per std-7 every
 * failure returns the SAME deny (close 1008, no detail) — unknown token, gone
 * user, unresolved memex, and no-read-access are indistinguishable to the client.
 */
export async function authenticateVoiceConnection(
  c: Context<Env>,
): Promise<VoiceAuthResult> {
  const token = c.req.query("token");
  if (!token) return DENY;

  let userId: string;
  try {
    userId = verifySessionToken(token).sub;
  } catch (err) {
    if (err instanceof InvalidTokenError) return DENY;
    throw err;
  }

  const user = await getUserById(userId);
  if (!user || user.status === "disabled") return DENY;

  const memex = c.get("memex");
  if (!memex) return DENY;

  const canRead = await canReadMemex(userId, memex.id);
  if (!canRead) return DENY;

  return { ok: true, userId, closeCode: 1000, closeReason: "ok" };
}

/** The minimal surface VoiceSession needs from a connection — satisfied by a
 *  WSContext in production and by a recording fake in tests. */
export interface VoiceSink {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Per-connection voice session: one socket is one session (ac-32). Holds the
 *  live STT session and the in-flight TTS abort controllers, and routes the wire
 *  protocol to the voice provider. */
export class VoiceSession {
  private stt: SttSession | null = null;
  private readonly ttsAborts = new Map<string, AbortController>();
  private torndown = false;

  constructor(
    private readonly sink: VoiceSink,
    private readonly opts: { configured: boolean; auth: VoiceAuthResult },
  ) {}

  /** Called once the socket opens: enforce config + auth, else close cleanly. */
  open(): void {
    if (!this.opts.configured) {
      this.sink.close(1011, "voice-unavailable");
      return;
    }
    if (!this.opts.auth.ok) {
      this.sink.close(this.opts.auth.closeCode, this.opts.auth.closeReason);
      return;
    }
    this.send({ type: "ready" });
  }

  /** A binary frame from the browser = a chunk of mic audio → STT. */
  handleBinary(bytes: Uint8Array): void {
    if (!this.active()) return;
    this.stt?.pushAudio(bytes);
  }

  /** A text frame = a JSON control message. */
  handleText(raw: string): void {
    if (!this.active()) return;
    let msg: { type?: string; requestId?: string; text?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "start_listening":
        this.startListening();
        break;
      case "end_utterance":
        this.stt?.endUtterance();
        break;
      case "speak":
        void this.speak(msg.requestId ?? "0", msg.text ?? "");
        break;
      case "abort": {
        // Barge-in cut (dec-8): abort the in-flight TTS for this request.
        const ac = msg.requestId ? this.ttsAborts.get(msg.requestId) : undefined;
        ac?.abort();
        if (msg.requestId) this.ttsAborts.delete(msg.requestId);
        break;
      }
      default:
        break;
    }
  }

  /** Tear the session down (close / error / barge-in): stop STT, abort all TTS. */
  teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.stt?.close();
    this.stt = null;
    for (const ac of this.ttsAborts.values()) ac.abort();
    this.ttsAborts.clear();
  }

  private active(): boolean {
    return this.opts.configured && this.opts.auth.ok && !this.torndown;
  }

  private send(payload: unknown): void {
    try {
      this.sink.send(JSON.stringify(payload));
    } catch {
      /* socket already closing */
    }
  }

  private startListening(): void {
    this.stt?.close();
    const provider = resolveVoiceProvider();
    const session = provider.openStt();
    this.stt = session;
    // Pump transcripts to the browser as they arrive (interim while the user is
    // still speaking, then final — ac-6).
    void (async () => {
      try {
        for await (const t of session.transcripts()) {
          this.send({ type: "transcript", text: t.text, isFinal: t.isFinal });
        }
      } catch {
        /* session torn down (close / barge-in) */
      }
    })();
  }

  private async speak(requestId: string, text: string): Promise<void> {
    const provider = resolveVoiceProvider();
    const ac = new AbortController();
    this.ttsAborts.set(requestId, ac);
    try {
      // Forward each TTS chunk the instant it arrives so playback can start
      // before synthesis finishes (ac-7); alignment rides along for dec-8.
      for await (const chunk of provider.synthesize(text, { signal: ac.signal })) {
        if (ac.signal.aborted) break;
        this.send({
          type: "audio",
          requestId,
          audio: Buffer.from(chunk.audio).toString("base64"),
          alignment: chunk.alignment,
          isFinal: chunk.isFinal,
        });
      }
    } catch {
      this.send({ type: "error", requestId, message: "tts_failed" });
    } finally {
      this.ttsAborts.delete(requestId);
    }
  }
}

function wsSink(ws: WSContext): VoiceSink {
  return {
    send: (data) => {
      try {
        ws.send(data);
      } catch {
        /* socket already closing */
      }
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
  };
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Build the voice router. `upgradeWebSocket` is created in app.ts via
 * createNodeWebSocket({ app }) and injected here (it must share the same app
 * instance whose server gets injectWebSocket() in index.ts).
 */
export function createVoiceRouter(upgradeWebSocket: UpgradeWebSocket): Hono<Env> {
  const router = new Hono<Env>();

  router.get(
    "/session",
    upgradeWebSocket(async (c) => {
      // Resolve provider availability + auth BEFORE the socket opens; both are
      // captured and enforced in open() so a denied connection closes cleanly.
      const configured = isVoiceConfigured();
      const auth = await authenticateVoiceConnection(c);
      let session: VoiceSession | null = null;

      return {
        onOpen(_evt, ws) {
          session = new VoiceSession(wsSink(ws), { configured, auth });
          session.open();
        },
        onMessage(evt, _ws) {
          if (!session) return;
          const data = evt.data;
          if (typeof data === "string") {
            session.handleText(data);
            return;
          }
          const bytes = toBytes(data as ArrayBuffer | ArrayBufferView);
          if (bytes) session.handleBinary(bytes);
        },
        onClose() {
          session?.teardown();
        },
        onError() {
          session?.teardown();
        },
      };
    }),
  );

  // POST /guide-chat — the guide's LLM text leg (dec-2: text stays SSE; the WS
  // above carries only audio). Mirrors routes/llm.ts /chat but with the guide
  // system prompt + the screen context + the GUIDE_TOOLS toolset, and NO tenant
  // document context or memex tools — the guide teaches the product, it never
  // reads the user's data (dec-4). The client-side LangGraph (guideGraph.ts)
  // drives this proxy; there is no server-side graph runtime (ac-11). Auth is
  // applied by sessionMiddleware on this path in app.ts (the WS self-auths; this
  // HTTP route carries a Bearer token like the rest of the API).
  router.post("/guide-chat", async (c) => {
    const parsed = guideChatSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const { messages, screenKey, screenRegistry, guideContext } = parsed.data;

    let anthropic: Anthropic;
    try {
      anthropic = getAnthropicClient();
    } catch (err) {
      if (err instanceof LlmNotConfiguredError) {
        return c.json({ error: "LLM unavailable", message: err.message }, 503);
      }
      throw err;
    }

    const systemBlocks = buildGuideSystemBlocks({
      screenKey: screenKey ?? null,
      screenRegistry: screenRegistry ?? [],
      guideContext: guideContext ?? [],
    });

    // Defeat reverse-proxy buffering so SSE deltas flush as they arrive.
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      try {
        const anthropicStream = anthropic.messages.stream({
          model: GUIDE_MODEL,
          max_tokens: 1024,
          system: systemBlocks as Anthropic.TextBlockParam[],
          tools: GUIDE_TOOLS as unknown as Anthropic.Tool[],
          messages: messages as MessageParam[],
        });
        anthropicStream.on("text", (text: string) => {
          stream.writeSSE({ event: "text_delta", data: JSON.stringify({ text }) });
        });
        const final = await anthropicStream.finalMessage();
        await stream.writeSSE({
          event: "message_complete",
          data: JSON.stringify({
            content: final.content as ContentBlockParam[],
            stopReason: final.stop_reason,
          }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        });
      }
    });
  });

  return router;
}
