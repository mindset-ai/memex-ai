// ElevenLabs voice provider — the server-side proxy around raw ElevenLabs STT/TTS
// primitives (spec-190 dec-2). This module is the ElevenLabs↔server leg of the
// voice loop; dec-9 puts a WebSocket on the browser↔server leg in front of it
// (routes/voice.ts). The ElevenLabs API key is read ONLY here, on the server —
// it never reaches the browser (ac-6). We deliberately do NOT use the hosted
// ElevenLabs Agents runtime: the guide's brain (the LangGraph graph, t-3) stays
// in our code; ElevenLabs is consumed as raw speech-in / speech-out primitives.
//
// Shape mirrors getAnthropicClient()/anthropic-fake.ts (std-11) and the
// EmbeddingProvider abstraction (resolveEmbeddingProvider): a lazily-resolved
// provider behind a small interface, with a deterministic fake double activated
// by MEMEX_ELEVENLABS_FAKE=1. The fake is what lets the proxy, the WS route
// (t-1), the barge-in engine (t-2), and the graph wiring (t-3) be exercised in
// tests without a real key or live audio. The real provider is validated once a
// key is provisioned (ELEVENLABS_API_KEY in packages/server/.env).

import { createFakeVoiceProvider } from "./elevenlabs-fake.js";

// ── Wire types shared by the real provider, the fake, and the WS route ────────

/** A transcript event from streaming STT. Interim events (`isFinal:false`)
 *  arrive WHILE the user is still speaking (ac-6); the `isFinal:true` event
 *  marks the end-of-utterance transcript the graph turn (t-3) consumes. */
export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
}

/** Character-level alignment for a span of synthesized speech. ElevenLabs's
 *  websocket TTS returns these timestamps; t-2 uses them to truncate an
 *  interrupted assistant turn to the words ACTUALLY spoken (dec-8). */
export interface TtsAlignment {
  chars: string[];
  /** Start offset of each char from the beginning of this synthesis, in ms. */
  charStartMs: number[];
  /** Duration of each char, in ms. */
  charDurationMs: number[];
}

/** One chunk of synthesized audio streamed back to the browser. Playback can
 *  start on the first chunk, before the full text has been synthesized (ac-7). */
export interface TtsAudioChunk {
  /** Raw audio bytes (encoding per `VoiceProvider.audioFormat`). */
  audio: Uint8Array;
  /** Alignment for the characters covered by this chunk, when available. */
  alignment?: TtsAlignment;
  /** True on the terminal chunk of a synthesis. */
  isFinal: boolean;
}

/** A live streaming-STT session. Audio frames are pushed in as they arrive from
 *  the browser; transcript events are consumed via the async iterator. */
export interface SttSession {
  /** Forward a chunk of mic audio (browser → server → ElevenLabs). */
  pushAudio(chunk: Uint8Array): void;
  /** Signal end-of-speech for the current utterance. */
  endUtterance(): void;
  /** Interim + final transcript events, in order. Completes when `close()` is
   *  called or the upstream STT stream ends. */
  transcripts(): AsyncIterable<TranscriptEvent>;
  /** Tear the session down (session end, or barge-in abort). Idempotent. */
  close(): void;
}

export interface SttOptions {
  /** PCM sample rate of the mic audio being pushed (Hz). */
  sampleRate?: number;
  /** BCP-47 language hint, e.g. "en". */
  languageCode?: string;
}

export interface TtsOptions {
  /** ElevenLabs voice id. Falls back to ELEVENLABS_VOICE_ID / a default. */
  voiceId?: string;
  /** Aborts the in-flight synthesis (barge-in cut, dec-8). */
  signal?: AbortSignal;
}

/** The provider surface the rest of the voice stack codes against. Both the real
 *  ElevenLabs implementation and the test fake satisfy it. */
export interface VoiceProvider {
  readonly name: string;
  /** Encoding of the audio bytes emitted by `synthesize` (e.g. "mp3_44100_128",
   *  "pcm_16000"). The browser playback queue (t-2) decodes accordingly. */
  readonly audioFormat: string;
  /** Open a streaming-STT session. */
  openStt(opts?: SttOptions): SttSession;
  /** Stream TTS audio for `text`. Async-iterable so the WS route can forward
   *  each chunk the instant it arrives (ac-7); abortable via `opts.signal`. */
  synthesize(text: string, opts?: TtsOptions): AsyncIterable<TtsAudioChunk>;
}

// ── Configuration error (mirrors LlmNotConfiguredError) ───────────────────────

export class VoiceNotConfiguredError extends Error {
  constructor() {
    super(
      "ELEVENLABS_API_KEY is not set. The voice guide (spec-190) is unavailable. " +
        "Set ELEVENLABS_API_KEY in packages/server/.env and restart the server, " +
        "or set MEMEX_ELEVENLABS_FAKE=1 to use the deterministic test double.",
    );
    this.name = "VoiceNotConfiguredError";
  }
}

// ── Resolution (mirrors getAnthropicClient + resolveEmbeddingProvider) ─────────

let cached: VoiceProvider | null = null;

/** Lazily resolve the voice provider:
 *   - MEMEX_ELEVENLABS_FAKE=1  → the deterministic in-memory double (tests/E2E).
 *   - ELEVENLABS_API_KEY set    → the real ElevenLabs provider.
 *   - neither                   → throws VoiceNotConfiguredError (→ 503 / WS 1011).
 *  Built once, on first use, so a missing key never throws at module load. */
export function resolveVoiceProvider(): VoiceProvider {
  if (cached) return cached;
  if (process.env.MEMEX_ELEVENLABS_FAKE === "1") {
    cached = createFakeVoiceProvider();
    return cached;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new VoiceNotConfiguredError();
  cached = new ElevenLabsVoiceProvider(key);
  return cached;
}

/** True when a provider can be resolved (real key or fake). The WS route uses
 *  this to reject a connect with a clean close code instead of throwing. */
export function isVoiceConfigured(): boolean {
  return (
    process.env.MEMEX_ELEVENLABS_FAKE === "1" || Boolean(process.env.ELEVENLABS_API_KEY)
  );
}

/** Test-only: drop the cached provider so a test can flip env between cases. */
export function __resetVoiceProviderForTests(): void {
  cached = null;
}

// ── Real ElevenLabs provider ──────────────────────────────────────────────────
//
// Wraps ElevenLabs's raw streaming primitives over WebSocket (the `ws` package,
// pulled in transitively by @hono/node-ws). The API key stays in these
// connections' auth — it is never serialized toward the browser (ac-6). This
// implementation targets ElevenLabs's documented streaming endpoints; it is
// exercised end-to-end only once a real key is provisioned. Every test path runs
// through the fake, so the proxy/route/client logic is verified independently of
// ElevenLabs availability.

const EL_BASE = "wss://api.elevenlabs.io";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs "Rachel" (documented default voice)
const DEFAULT_TTS_MODEL = "eleven_flash_v2_5"; // lowest-latency model — the ping budget (dec-6) is tight
const DEFAULT_TTS_FORMAT = "mp3_44100_128";
// Realtime STT is Scribe v2 Realtime (the older scribe_v1 is batch-only). Endpoint,
// message protocol, and model were validated against the live API via
// scripts/smoke-elevenlabs.ts. Overridable so a model bump needs no code change.
const DEFAULT_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2_realtime";

class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  readonly audioFormat = DEFAULT_TTS_FORMAT;

  constructor(private readonly apiKey: string) {}

  openStt(opts: SttOptions = {}): SttSession {
    return new ElevenLabsSttSession(this.apiKey, opts);
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<TtsAudioChunk> {
    const voiceId = opts.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID;
    // Dynamic import keeps `ws` off the module-load path (and out of any bundle
    // that never opens a session); it ships with @hono/node-ws.
    const { WebSocket } = await import("ws");
    const url =
      `${EL_BASE}/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${DEFAULT_TTS_MODEL}&output_format=${this.audioFormat}` +
      // Request char-level alignment so t-2 can truncate interrupted turns (dec-8).
      `&sync_alignment=true`;
    const ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });

    const queue = new AsyncChunkQueue<TtsAudioChunk>();
    const abort = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      queue.close();
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    ws.on("open", () => {
      // ElevenLabs stream-input protocol: send voice settings, then the text,
      // then an empty string to flush + close the input side.
      ws.send(JSON.stringify({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
      ws.send(JSON.stringify({ text }));
      ws.send(JSON.stringify({ text: "" }));
    });
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const chunk: TtsAudioChunk = {
          audio: msg.audio ? Uint8Array.from(Buffer.from(msg.audio, "base64")) : new Uint8Array(),
          alignment: msg.alignment
            ? {
                chars: msg.alignment.chars ?? [],
                charStartMs: (msg.alignment.charStartTimesMs ?? msg.alignment.char_start_times_ms ?? []) as number[],
                charDurationMs: (msg.alignment.charDurationsMs ?? msg.alignment.char_durations_ms ?? []) as number[],
              }
            : undefined,
          isFinal: Boolean(msg.isFinal),
        };
        queue.push(chunk);
        if (chunk.isFinal) queue.close();
      } catch {
        /* non-JSON keepalive frame — ignore */
      }
    });
    ws.on("close", () => queue.close());
    ws.on("error", (err: Error) => queue.fail(err));

    yield* queue.drain();
  }
}

class ElevenLabsSttSession implements SttSession {
  private ws: import("ws").WebSocket | null = null;
  private readonly ready: Promise<import("ws").WebSocket>;
  private readonly queue = new AsyncChunkQueue<TranscriptEvent>();
  private closed = false;

  constructor(apiKey: string, opts: SttOptions) {
    const sampleRate = opts.sampleRate ?? 16000;
    this.ready = (async () => {
      const { WebSocket } = await import("ws");
      // Scribe v2 Realtime WS contract: audio arrives as base64 `input_audio_chunk`
      // messages, end-of-utterance is a chunk with `commit: true` (commit_strategy
      // manual — the client owns end-of-speech via the VAD, dec-8), and transcripts
      // come back as partial_transcript / committed_transcript messages.
      const url =
        `${EL_BASE}/v1/speech-to-text/realtime` +
        `?model_id=${DEFAULT_STT_MODEL}&audio_format=pcm_${sampleRate}&commit_strategy=manual` +
        (opts.languageCode ? `&language_code=${opts.languageCode}` : "");
      const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
      ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          switch (msg.message_type) {
            case "partial_transcript":
              if (typeof msg.text === "string") this.queue.push({ text: msg.text, isFinal: false });
              break;
            case "committed_transcript":
            case "committed_transcript_with_timestamps":
              if (typeof msg.text === "string") this.queue.push({ text: msg.text, isFinal: true });
              break;
            default:
              /* ignore session_started / VAD / other control frames */
          }
        } catch {
          /* ignore non-JSON frames */
        }
      });
      ws.on("close", () => this.queue.close());
      ws.on("error", (err: Error) => this.queue.fail(err));
      this.ws = ws;
      return ws;
    })();
  }

  pushAudio(chunk: Uint8Array): void {
    if (this.closed) return;
    void this.ready.then((ws) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: Buffer.from(chunk).toString("base64"),
        }),
      );
    });
  }

  endUtterance(): void {
    void this.ready.then((ws) => {
      if (ws.readyState !== ws.OPEN) return;
      // Commit the current utterance: an input_audio_chunk with commit=true.
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true }));
    });
  }

  transcripts(): AsyncIterable<TranscriptEvent> {
    return this.queue.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.ready.then((ws) => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });
    this.queue.close();
  }
}

// ── A tiny push→pull async queue bridging event-emitter streams to async iteration ──
// Shared by the STT/TTS sessions and the fake. Keeps the provider surface
// (async iterables) clean over ws's callback API.
export class AsyncChunkQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private done = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.done) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      this.rejecters.shift();
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    for (const resolve of this.resolvers) resolve({ value: undefined as never, done: true });
    this.resolvers = [];
    this.rejecters = [];
  }

  fail(err: unknown): void {
    if (this.done) return;
    this.error = err;
    this.done = true;
    for (const reject of this.rejecters) reject(err);
    this.resolvers = [];
    this.rejecters = [];
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.resolvers.push(resolve);
        this.rejecters.push(reject);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
