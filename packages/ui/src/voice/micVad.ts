// spec-190 t-2 / dec-8 / ac-23: microphone capture + client-side voice-activity
// detection. Speech onset is detected LOCALLY (a Silero VAD running in an
// AudioWorklet) with no server round-trip, and the mic is opened with
// echoCancellation so the agent's own playback — including the ping and other
// earcons — is stripped from the mic signal and can't trigger barge-in (ac-23).
//
// MicVad is written against injectable deps (getUserMedia + a VadEngine) so the
// wiring + AEC constraints are unit-testable without real Web Audio. The real
// engine (SileroWorkletVadEngine) is browser glue: it loads the VAD worklet and
// streams onset/end events; it runs only in a browser and is validated on a real
// device, not in jsdom.

/**
 * Mic capture constraints. echoCancellation is the load-bearing flag for ac-23:
 * the browser's AEC removes the agent's own speaker output (and earcons) from the
 * captured signal, so playback can't be mistaken for the user speaking.
 */
export function micConstraints(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
}

/** Turns a captured mic stream into speech onset/end signals, locally. */
export interface VadEngine {
  /** Begin processing; invoke `onSpeech(true)` on onset, `onSpeech(false)` on end. */
  start(stream: MediaStream, onSpeech: (speaking: boolean) => void): Promise<void>;
  stop(): void;
}

export interface MicVadDeps {
  /** Defaults to navigator.mediaDevices.getUserMedia, injectable for tests. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** The local VAD engine (real = Silero worklet; fake in tests). */
  engine: VadEngine;
}

export class MicPermissionError extends Error {
  // Declared explicitly: Error.cause is ES2022, but the UI lib targets ES2020,
  // so the base type doesn't carry it. Declaring our own keeps the field typed
  // without a workspace-wide lib bump.
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('Microphone permission denied or unavailable');
    this.name = 'MicPermissionError';
    this.cause = cause;
  }
}

/**
 * Opens the mic with AEC and routes its frames through a local VAD engine,
 * surfacing speech onset/end to the barge-in controller. No network — detection
 * is entirely client-side (ac-23).
 */
export class MicVad {
  private stream: MediaStream | null = null;
  private readonly getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;

  constructor(private readonly deps: MicVadDeps) {
    this.getUserMedia =
      deps.getUserMedia ??
      ((c) => navigator.mediaDevices.getUserMedia(c));
  }

  async start(onSpeechStart: () => void, onSpeechEnd: () => void): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia(micConstraints());
    } catch (err) {
      // Surfaced to the session-entry UX (t-8) for the denied-state recovery flow.
      throw new MicPermissionError(err);
    }
    this.stream = stream;
    await this.deps.engine.start(stream, (speaking) => {
      if (speaking) onSpeechStart();
      else onSpeechEnd();
    });
  }

  stop(): void {
    this.deps.engine.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// ── Real engine: Silero VAD in an AudioWorklet (via @ricky0123/vad-web) ────────
// Browser glue. Runs the Silero VAD model locally in an AudioWorklet over the
// AEC'd mic stream WE opened, and translates vad-web's speech-start/end callbacks
// into our onset/end signal. Detection is entirely client-side — no server
// round-trip (ac-23).
//
// Two load-bearing choices:
//   - getStream returns OUR stream (opened with echoCancellation in MicVad), so
//     the agent's own playback + earcons are stripped before the VAD sees them
//     (ac-23). vad-web would otherwise open its own mic without our constraints.
//   - processorType 'AudioWorklet' forces the worklet path (not the legacy
//     ScriptProcessor main-thread fallback), matching dec-8/ac-23.
//
// The runtime assets (worklet bundle, Silero .onnx, onnxruntime-web .wasm) are
// served from `baseAssetPath` / `onnxWASMBasePath` — staged into public/vad by
// scripts/copy-vad-assets.mjs (predev/prebuild). Validated on a real device
// (jsdom has no AudioWorklet / WebAssembly mic pipeline), the same way t-1's real
// ElevenLabs provider is validated once a key lands.
export interface SileroWorkletOptions {
  /** Where the worklet bundle + Silero ONNX model are served (default '/vad/'). */
  baseAssetPath?: string;
  /** Where the onnxruntime-web wasm is served (default '/vad/'). */
  onnxWASMBasePath?: string;
  /** Silero model variant. Default 'v5' (current); 'legacy' is the older model. */
  model?: 'v5' | 'legacy';
  /** Speech-onset probability threshold (0..1). vad-web default ~0.5. */
  positiveSpeechThreshold?: number;
}

// Minimal structural type for the vad-web handle we use — keeps this module from
// hard-importing the lib's types at the top level (the import is dynamic so the
// ONNX/wasm machinery stays off the load path until a session actually starts).
interface MicVadHandle {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
}

export class SileroWorkletVadEngine implements VadEngine {
  private vad: MicVadHandle | null = null;

  constructor(private readonly opts: SileroWorkletOptions = {}) {}

  async start(stream: MediaStream, onSpeech: (speaking: boolean) => void): Promise<void> {
    const { MicVAD } = await import('@ricky0123/vad-web');
    const base = this.opts.baseAssetPath ?? '/vad/';
    this.vad = await MicVAD.new({
      // Use the AEC'd stream we already opened — never let vad-web open its own.
      getStream: async () => stream,
      model: this.opts.model ?? 'v5',
      processorType: 'AudioWorklet',
      baseAssetPath: base,
      onnxWASMBasePath: this.opts.onnxWASMBasePath ?? base,
      startOnLoad: false,
      ...(this.opts.positiveSpeechThreshold != null
        ? { positiveSpeechThreshold: this.opts.positiveSpeechThreshold }
        : {}),
      onSpeechStart: () => onSpeech(true),
      onSpeechEnd: () => onSpeech(false),
      // A misfire (onset with too-short speech) must still restore state — treat
      // it as an end so a ducked playback isn't left ducked (dec-8).
      onVADMisfire: () => onSpeech(false),
    });
    await this.vad.start();
  }

  stop(): void {
    const vad = this.vad;
    this.vad = null;
    if (!vad) return;
    // Pause synchronously-ish, then fully tear down; both are idempotent.
    void vad.destroy().catch(() => {
      /* already torn down */
    });
  }
}
