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
import { isDevMode, resolveDevUser } from "../middleware/session.js";
import { canReadMemex } from "../mcp/auth.js";
import {
  isVoiceConfigured,
  resolveVoiceProvider,
  type SttSession,
} from "../agent/elevenlabs-client.js";
import { getAnthropicClient, LlmNotConfiguredError } from "../agent/anthropic-client.js";
import { buildGuideSystemBlocks } from "../agent/voice/guide-prompt.js";
import {
  prefetchScreenContent,
  searchGuideContent,
  type GuideSurface,
} from "../services/guide-content.js";
import { GUIDE_TOOLS } from "@memex/shared";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import type { SessionEnv } from "../middleware/session.js";

// The voice guide deliberately runs a FASTER model than the main agent proxy
// (routes/llm.ts uses Sonnet). Voice replies are short (max_tokens kept low) and
// TTS streams from the first token, so the FELT latency is time-to-first-token —
// which dominated the "thinking" gap (int guide-chat ran ~2-3s/turn on Sonnet).
// Haiku's lower TTFT is the win for short product-navigation answers; the small
// quality trade is acceptable here (spec-190 latency follow-up).
export const GUIDE_MODEL = "claude-haiku-4-5-20251001";

export const guideChatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.any() })),
  screenKey: z.string().nullable().optional(),
  screenRegistry: z
    .array(z.object({ id: z.string(), description: z.string() }))
    .optional(),
  guideContext: z.array(z.string()).optional(),
});

/** Pull the most recent user-turn text (the finalized utterance) out of the
 *  Anthropic-shaped message list — string content or text blocks. Used to drive
 *  the per-turn Layer-2 retrieval (ac-15). Exported so the public anonymous guide
 *  router (spec-222 t-10) reuses the SAME extraction rather than forking it. */
export function latestUserUtterance(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    return "";
  }
  return "";
}

/**
 * Assemble the guide context SERVER-side (dec-6): Layer 1 = the current screen's
 * chunks (deterministic screen_key lookup) + Layer 2 = a per-turn vector/FTS
 * search over the whole corpus on the latest utterance. Both run every turn, so
 * answering never depends on the agent choosing to call search_guide (ac-15).
 * Best-effort — a retrieval failure degrades to whatever else we have, never
 * fails the turn. Deduped; client-supplied context (if any) wins ordering.
 */
export async function assembleGuideContext(
  screenKey: string | null,
  utterance: string,
  clientContext: string[] | undefined,
  // spec-222 t-7 (dec-3): retrieval is surface-keyed. The authenticated in-app
  // voice path reads the 'memex-app' corpus (the default, behaviour unchanged);
  // the public anonymous path (spec-222 t-10) passes the surface bound into its
  // signed session token. Either way the surface is a SERVER-supplied argument,
  // NEVER client free input.
  surface: GuideSurface = "memex-app",
): Promise<string[]> {
  const [screenChunks, searchHits] = await Promise.all([
    screenKey ? prefetchScreenContent(screenKey, surface).catch(() => []) : Promise.resolve<string[]>([]),
    utterance.trim()
      ? searchGuideContent(utterance, { surface, limit: 4 }).then((h) => h.map((x) => x.content)).catch(() => [])
      : Promise.resolve<string[]>([]),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of [...(clientContext ?? []), ...screenChunks, ...searchHits]) {
    const key = chunk.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(chunk);
    }
  }
  return out;
}

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

  // Resolve the caller from the connect-query token. Mirror the HTTP session
  // middleware's dev-mode posture (resolveBearerUser): a missing or
  // malformed/expired token in dev mode falls back to the dev user, so the WS
  // keeps working without a real login — and survives the ephemeral-JWT-secret
  // reset on every dev server restart (which invalidates previously-minted
  // tokens). In production isDevMode() is false, so this stays strict: no token
  // or a bad token denies. Without this the voice WS was the ONLY auth path
  // lacking the dev bypass, so it 1008'd every local session after a restart.
  const devMode = isDevMode();
  let userId: string | undefined;
  if (token) {
    try {
      userId = verifySessionToken(token).sub;
    } catch (err) {
      if (!(err instanceof InvalidTokenError)) throw err;
      userId = undefined; // malformed/expired — fall through to dev fallback / deny
    }
  }
  if (!userId) {
    if (!devMode) return DENY;
    userId = (await resolveDevUser()).id;
  }

  let user = await getUserById(userId);
  if (!user && devMode) {
    // Valid token whose subject doesn't exist in THIS database — e.g. a prod/int
    // memex.ai token sitting in localStorage while developing locally (the JWT
    // secret verifies it, but the user UUID is only in the other DB). Mirror
    // resolveBearerUser's userGone→dev fallback (session.ts) so a stale token
    // never bricks local voice. Production (devMode=false) still denies.
    const dev = await resolveDevUser();
    userId = dev.id;
    user = dev;
  }
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

/** Per-session abuse cap (spec-222 t-11 → ac-16). The PUBLIC anonymous guide
 *  (memex-website) is internet-exposed with no login, so a single session must be
 *  bounded so a connected client can't run unbounded TTS/LLM work on our keys. The
 *  cap lives in the VoiceSession lifecycle — one socket is one session (ac-32), so
 *  the metering naturally belongs here. The authenticated in-app path passes no
 *  cap (undefined ⇒ unbounded, behaviour unchanged). A "turn" is one `speak`
 *  request (the unit of TTS/LLM cost on the WS leg). */
export interface VoiceSessionCap {
  /** Max `speak` turns before the session ends. */
  maxTurns: number;
  /** Wall-clock budget from open() before the session ends, in milliseconds. */
  maxWallClockMs: number;
}

/** Per-connection voice session: one socket is one session (ac-32). Holds the
 *  live STT session and the in-flight TTS abort controllers, and routes the wire
 *  protocol to the voice provider. */
export class VoiceSession {
  private stt: SttSession | null = null;
  private readonly ttsAborts = new Map<string, AbortController>();
  private torndown = false;
  private turnsUsed = 0;
  private openedAtMs = 0;
  private capExceeded = false;

  constructor(
    private readonly sink: VoiceSink,
    private readonly opts: {
      configured: boolean;
      auth: VoiceAuthResult;
      /** When set (public anonymous guide, t-11), the session is hard-capped. */
      cap?: VoiceSessionCap;
    },
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
    this.openedAtMs = Date.now();
    this.send({ type: "ready" });
  }

  /** True once a cap (turns OR wall-clock) has been exceeded. After this the
   *  session refuses further TTS/LLM work and is torn down. Exposed so tests can
   *  assert the cap fired. */
  isCapExceeded(): boolean {
    return this.capExceeded;
  }

  /** Returns true if the cap is now exceeded — ends the session as a side effect
   *  (sends one 'error' frame, tears down STT/TTS, closes the socket 1011). No-op
   *  when there's no cap configured (the authenticated in-app path). */
  private capReached(): boolean {
    const cap = this.opts.cap;
    if (!cap) return false;
    if (this.capExceeded) return true;
    const overTurns = this.turnsUsed >= cap.maxTurns;
    const overClock = this.openedAtMs > 0 && Date.now() - this.openedAtMs >= cap.maxWallClockMs;
    if (overTurns || overClock) {
      this.capExceeded = true;
      // Surface a terminal error so the client can show "session ended", then end.
      this.send({ type: "error", message: "session_limit_reached" });
      this.teardown();
      this.sink.close(1011, "session-limit-reached");
      return true;
    }
    return false;
  }

  /** A binary frame from the browser = a chunk of mic audio → STT.
   *
   *  spec-214 dec-2 (server backstop): while a TTS `speak` is in flight for this
   *  session, DROP inbound audio rather than appending it to STT. On a speaker-
   *  equipped device the agent's own playback bleeds into the mic; forwarding it
   *  would let STT transcribe Specky's own words and feed them back as a user turn
   *  (the self-talk loop). The client also gates this (dec-1), but the server is
   *  authoritative — it holds even if a client regresses. */
  handleBinary(bytes: Uint8Array): void {
    if (!this.active()) return;
    if (this.ttsAborts.size > 0) return; // agent is speaking — ignore captured echo
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
      case "speak": {
        // Per-session hard cap (t-11 → ac-16): a `speak` is the TTS/LLM unit of
        // cost. Count this turn, then refuse + end the session if the cap is now
        // reached — so no TTS work is performed past the limit.
        this.turnsUsed += 1;
        if (this.capReached()) break;
        void this.speak(msg.requestId ?? "0", msg.text ?? "");
        break;
      }
      case "abort": {
        // Stop / new-turn supersede (spec-214 dec-4): abort the in-flight TTS for
        // this request. (Was barge-in cut, dec-8 — voice barge-in now removed.)
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
    if (!(this.opts.configured && this.opts.auth.ok && !this.torndown)) return false;
    // Enforce the wall-clock budget lazily on any inbound frame — a session that
    // has burned its time is ended even if it stopped sending `speak` (t-11).
    if (this.capReached()) return false;
    return true;
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
      // A barge-in / Stop aborts the synthesize() generator mid-stream, which
      // surfaces here as a throw — that is INTENTIONAL, not a failure. Sending an
      // error frame would make the client escalate to status:'error', which
      // unmounts the pill (the beep-then-close bug) and kills the session on every
      // interruption. Only surface a REAL synthesis failure (not an abort).
      if (!ac.signal.aborted) {
        this.send({ type: "error", requestId, message: "tts_failed" });
      }
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
  // above carries only audio). Auth is applied by sessionMiddleware on this path
  // in app.ts (the WS self-auths; this HTTP route carries a Bearer token like the
  // rest of the API). The SURFACE is fixed to 'memex-app' here: this is the
  // authenticated in-app leg. The public anonymous leg (spec-222 t-10) reuses the
  // SAME handler via handleGuideChat() with the surface bound from its signed token.
  router.post("/guide-chat", (c) => handleGuideChat(c, "memex-app"));

  return router;
}

/**
 * The guide's LLM text leg, single-sourced (spec-222 t-10 — do not fork the
 * proxy). Mirrors routes/llm.ts /chat but with the guide system prompt + screen
 * context + the GUIDE_TOOLS toolset, and NO tenant document context or memex
 * tools — the guide teaches the product, it never reads the user's data (dec-4).
 * The client-side LangGraph drives this proxy; there is no server-side graph
 * runtime (ac-11).
 *
 * `surface` is ALWAYS server-supplied — fixed to 'memex-app' for the authenticated
 * in-app router, and bound from the signed anon token for the public router. It is
 * NEVER read from the request body (guideChatSchema strips any extra field, and
 * buildGuideSystemBlocks derives the persona solely from this surface — the
 * prompt-injection guard, ac-20).
 */
export async function handleGuideChat(
  c: Context,
  surface: GuideSurface,
): Promise<Response> {
  const parsed = guideChatSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid request" }, 400);
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

  // Layer 1 + Layer 2 retrieval, server-side, every turn (ac-15), scoped to the
  // server-supplied surface (ac-4 / ac-11 / ac-12 corpus isolation).
  const retrievedContext = await assembleGuideContext(
    screenKey ?? null,
    latestUserUtterance(messages),
    guideContext,
    surface,
  );

  // spec-222 t-9 (dec-6 → ac-20): the persona is selected SERVER-side by surface.
  // No system/persona/prompt text is EVER read from the request body.
  const systemBlocks = buildGuideSystemBlocks({
    surface,
    screenKey: screenKey ?? null,
    screenRegistry: screenRegistry ?? [],
    guideContext: retrievedContext,
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
}
