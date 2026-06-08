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
  /** Sustained-speech threshold before a full cut (~300ms). */
  cutMs?: number;
  /** Continuous-silence window that confirms a transient and aborts the pending
   *  cut (~120ms). A gap SHORTER than this is tolerated — the cut keeps heading
   *  in — so choppy real interruption speech (and speaker echo flicker) still
   *  cuts; only sustained silence restores. */
  restoreMs?: number;
}

/** Char-level alignment for a synthesized chunk (from ElevenLabs TTS). */
export interface CharAlignment {
  chars: string[];
  /** Start offset of each char from the start of the turn, in ms (absolute). */
  charStartMs: number[];
}

const DEFAULT_DUCK_MS = 50;
// Sustained-interruption window before a hard cut. The FELT responsiveness comes
// from the deep duck at onset (playbackQueue ducks the agent to ~5% in ~50ms — the
// user instantly hears it yield), so this window can be long enough to be robust
// without feeling laggy. It is gap-TOLERANT: armed once on the first onset and NOT
// reset by brief VAD dips (real interruption speech is choppy, and on speakers the
// agent's echo bleed makes the VAD flicker). Only `restoreMs` of CONTINUOUS silence
// aborts it — see onSpeechEnd. (dec-8 / t-9; was 160ms, which never landed because
// any single dip cancelled it.)
const DEFAULT_CUT_MS = 300;
// Continuous silence that confirms a blip was a transient (cough/backchannel) and
// restores full volume. Must stay BELOW cutMs so a genuine transient restores
// before the cut fires; the gap between them is the speech-gap tolerance.
const DEFAULT_RESTORE_MS = 120;

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
  // Pending "this was a transient, restore" timer — armed on a VAD gap while
  // ducked, cancelled if speech resumes before it fires (gap tolerance).
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  // Accumulated alignment of the CURRENT assistant turn, for truncation on cut.
  private chars: string[] = [];
  private startMs: number[] = [];
  private readonly duckMs: number;
  private readonly cutMs: number;
  private readonly restoreMs: number;

  constructor(
    private readonly playback: PlaybackSink,
    private readonly cb: BargeInCallbacks,
    opts: BargeInOptions = {},
  ) {
    this.duckMs = opts.duckMs ?? DEFAULT_DUCK_MS;
    this.cutMs = opts.cutMs ?? DEFAULT_CUT_MS;
    this.restoreMs = opts.restoreMs ?? DEFAULT_RESTORE_MS;
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
    this.clearTimers();
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
    this.clearTimers();
    if (this._state !== 'cut') this._state = 'idle';
  }

  /** VAD speech onset. While the agent speaks: duck immediately and arm the
   *  sustained-interruption cut timer. A re-onset after a brief gap cancels the
   *  pending restore and KEEPS the cut timer running (gap tolerance) — it never
   *  re-arms, so the cut measures sustained interruption from the FIRST onset.
   *  Inert outside a turn — there's nothing to interrupt, and the agent's own
   *  earcons never reach here (AEC, ac-23). */
  onSpeechStart(): void {
    this.clearRestoreTimer(); // speech (re)started — this was not sustained silence
    if (this._state === 'speaking') {
      this.playback.duck(); // agent audibly yields (deep + fast ~duckMs ramp)
      this._state = 'ducked';
      this.armCutTimer();
    } else if (this._state === 'ducked') {
      this.armCutTimer(); // already ducked mid-interruption; keep the timer running
    }
    // 'idle' / 'cut' → inert.
  }

  /** VAD speech end. A single gap does NOT restore — real interruption speech is
   *  choppy and speaker echo makes the VAD flicker, so an immediate restore is why
   *  the cut never landed. Instead arm a restore timer: only `restoreMs` of
   *  CONTINUOUS silence confirms a transient (cough/backchannel) and restores +
   *  cancels the cut. If speech resumes first, onSpeechStart cancels this and the
   *  cut keeps heading in. */
  onSpeechEnd(): void {
    if (this._state !== 'ducked') return;
    this.armRestoreTimer();
  }

  /** Manual tap-to-interrupt fallback: immediate full cut. */
  tapInterrupt(): void {
    if (this._state === 'speaking' || this._state === 'ducked') this.cut();
  }

  dispose(): void {
    this.clearTimers();
  }

  private armCutTimer(): void {
    if (this.cutTimer) return;
    this.cutTimer = setTimeout(() => {
      this.cutTimer = null;
      this.cut();
    }, this.cutMs);
  }

  /** Arm the transient-confirm timer: sustained silence → restore + cancel cut. */
  private armRestoreTimer(): void {
    if (this.restoreTimer) return;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      this.clearCutTimer();
      this.playback.restore();
      this._state = 'speaking';
    }, this.restoreMs);
  }

  private clearCutTimer(): void {
    if (this.cutTimer) {
      clearTimeout(this.cutTimer);
      this.cutTimer = null;
    }
  }

  private clearRestoreTimer(): void {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearCutTimer();
    this.clearRestoreTimer();
  }

  private cut(): void {
    this.clearTimers();
    // Truncate to the words actually heard BEFORE flushing (playedMs is read now).
    const spoken = spokenPrefix(this.chars, this.startMs, this.playback.playedMs());
    this.playback.flush();
    this.cb.abortTts();
    this.cb.abortLlm();
    this._state = 'cut';
    this.cb.onCut(spoken);
  }
}
