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

// ── Real engine: Silero VAD in an AudioWorklet ────────────────────────────────
// Browser glue. Loads the VAD worklet module, pipes the AEC'd mic stream through
// it, and translates its frame-level decisions into onset/end events. The worklet
// + Silero WASM asset are validated on a real device (jsdom has no AudioWorklet),
// the same way t-1's real ElevenLabs provider is validated once a key lands.
export interface SileroWorkletOptions {
  /** URL of the VAD AudioWorklet processor module (bundled asset). */
  workletUrl: string;
  /** Probability threshold for "speech" (0..1). */
  threshold?: number;
}

export class SileroWorkletVadEngine implements VadEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly opts: SileroWorkletOptions) {}

  async start(stream: MediaStream, onSpeech: (speaking: boolean) => void): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(this.opts.workletUrl);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'silero-vad', {
      processorOptions: { threshold: this.opts.threshold ?? 0.5 },
    });
    // The worklet posts { speaking: boolean } as its decision flips. Detection is
    // local to the worklet thread — no network, ~1ms/frame.
    node.port.onmessage = (e: MessageEvent<{ speaking: boolean }>) => {
      onSpeech(Boolean(e.data?.speaking));
    };
    source.connect(node);
    // Do NOT connect the node to ctx.destination — the VAD is a sink, we never
    // want the mic echoed to the speakers.
    this.source = source;
    this.node = node;
  }

  stop(): void {
    try {
      this.node?.port.close();
      this.source?.disconnect();
      this.node?.disconnect();
      void this.ctx?.close();
    } finally {
      this.node = null;
      this.source = null;
      this.ctx = null;
    }
  }
}
