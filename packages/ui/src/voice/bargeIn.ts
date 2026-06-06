// spec-190 t-2 / dec-8: duck-then-cut barge-in. This module is the pure logic
// core — a state machine + a truncation function — written against small
// interfaces so it is fully unit-testable with fake timers and no Web Audio. The
// browser glue lives next door: mic capture + Silero VAD in micVad.ts, the Web
// Audio playback queue in playbackQueue.ts.
//
// Barge-in is a JavaScript-land reflex, never a server round-trip (dec-8). The
// flow while the agent is speaking:
//   VAD onset      → duck playback immediately (~duckMs ramp); arm the cut timer.
//   sustained ~cutMs → full cut: flush playback, abort the TTS websocket AND the
//                      LLM stream, and hand back the assistant turn truncated to
//                      the words actually spoken (alignment timestamps).
//   onset then end before cutMs → transient (backchannel/cough): restore, no cut.
// Tap-to-interrupt is a manual immediate cut. The agent's own playback + earcons
// can't reach the VAD — AEC strips them at the mic (ac-23, enforced in micVad).

export type BargeInState = 'idle' | 'speaking' | 'ducked' | 'cut';

/** What the controller needs from the audio playback layer. */
export interface PlaybackSink {
  /** Drop playback volume promptly (the agent audibly yields). */
  duck(): void;
  /** Restore full volume after a transient. */
  restore(): void;
  /** Stop playback and clear the queued audio (hard cut). */
  flush(): void;
  /** Milliseconds of audio actually played in the current turn (truncation). */
  playedMs(): number;
}

export interface BargeInCallbacks {
  /** Abort the in-flight ElevenLabs TTS websocket leg. */
  abortTts(): void;
  /** Abort the in-flight LLM stream (AbortController). */
  abortLlm(): void;
  /** The interrupted assistant turn, truncated to the words the user heard. */
  onCut(spokenText: string): void;
}

export interface BargeInOptions {
  /** Duck ramp duration the playback layer targets (~50ms). Advisory here. */
  duckMs?: number;
  /** Sustained-speech threshold before a full cut (~250–300ms). */
  cutMs?: number;
}

/** Char-level alignment for a synthesized chunk (from ElevenLabs TTS). */
export interface CharAlignment {
  chars: string[];
  /** Start offset of each char from the start of the turn, in ms (absolute). */
  charStartMs: number[];
}

const DEFAULT_DUCK_MS = 50;
const DEFAULT_CUT_MS = 280;

/**
 * The prefix of the synthesized text whose characters had begun playing by
 * `cutMs` — i.e. the words the user actually heard before the cut. `charStartMs`
 * are absolute within the turn (accumulated across chunks). Pure + deterministic.
 */
export function spokenPrefix(chars: string[], charStartMs: number[], cutMs: number): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (charStartMs[i] <= cutMs) out += chars[i];
    else break;
  }
  return out;
}

export class BargeInController {
  private _state: BargeInState = 'idle';
  private cutTimer: ReturnType<typeof setTimeout> | null = null;
  // Accumulated alignment of the CURRENT assistant turn, for truncation on cut.
  private chars: string[] = [];
  private startMs: number[] = [];
  private readonly duckMs: number;
  private readonly cutMs: number;

  constructor(
    private readonly playback: PlaybackSink,
    private readonly cb: BargeInCallbacks,
    opts: BargeInOptions = {},
  ) {
    this.duckMs = opts.duckMs ?? DEFAULT_DUCK_MS;
    this.cutMs = opts.cutMs ?? DEFAULT_CUT_MS;
  }

  get state(): BargeInState {
    return this._state;
  }
  get duckDelayMs(): number {
    return this.duckMs;
  }
  get cutDelayMs(): number {
    return this.cutMs;
  }

  /** Agent begins a spoken turn — reset truncation accounting. */
  startTurn(): void {
    this.clearCutTimer();
    this.chars = [];
    this.startMs = [];
    this._state = 'speaking';
  }

  /** Accumulate a synthesized chunk's alignment so a later cut can truncate. */
  appendChunk(alignment: CharAlignment | undefined): void {
    if (!alignment) return;
    for (let i = 0; i < alignment.chars.length; i++) {
      this.chars.push(alignment.chars[i]);
      this.startMs.push(alignment.charStartMs[i] ?? 0);
    }
  }

  /** Agent finished speaking naturally (no interruption). */
  endTurn(): void {
    this.clearCutTimer();
    if (this._state !== 'cut') this._state = 'idle';
  }

  /** VAD speech onset. While the agent speaks: duck immediately and arm the
   *  sustained-speech cut timer. Inert outside a turn — there's nothing to
   *  interrupt, and the agent's own earcons never reach here (AEC, ac-23). */
  onSpeechStart(): void {
    if (this._state === 'speaking') {
      this.playback.duck(); // agent audibly yields (~duckMs ramp)
      this._state = 'ducked';
      this.armCutTimer();
    } else if (this._state === 'ducked') {
      this.armCutTimer(); // already ducked; ensure the cut timer is running
    }
    // 'idle' / 'cut' → inert.
  }

  /** VAD speech end. If it ends before the cut fires it was a transient
   *  (backchannel/cough): restore volume, cancel the pending cut. */
  onSpeechEnd(): void {
    if (this._state !== 'ducked') return;
    this.clearCutTimer();
    this.playback.restore();
    this._state = 'speaking';
  }

  /** Manual tap-to-interrupt fallback: immediate full cut. */
  tapInterrupt(): void {
    if (this._state === 'speaking' || this._state === 'ducked') this.cut();
  }

  dispose(): void {
    this.clearCutTimer();
  }

  private armCutTimer(): void {
    if (this.cutTimer) return;
    this.cutTimer = setTimeout(() => {
      this.cutTimer = null;
      this.cut();
    }, this.cutMs);
  }

  private clearCutTimer(): void {
    if (this.cutTimer) {
      clearTimeout(this.cutTimer);
      this.cutTimer = null;
    }
  }

  private cut(): void {
    this.clearCutTimer();
    // Truncate to the words actually heard BEFORE flushing (playedMs is read now).
    const spoken = spokenPrefix(this.chars, this.startMs, this.playback.playedMs());
    this.playback.flush();
    this.cb.abortTts();
    this.cb.abortLlm();
    this._state = 'cut';
    this.cb.onCut(spoken);
  }
}
