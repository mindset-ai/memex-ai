// spec-190 t-2 / dec-8: the Web Audio playback queue — the PlaybackSink the
// BargeInController (bargeIn.ts) drives. Browser glue: it schedules streamed TTS
// audio chunks gaplessly, ducks/restores via a gain ramp, hard-flushes on cut,
// and reports how much audio has actually played (for truncation). It runs only
// in a browser (AudioContext); like t-1's real ElevenLabs provider it is
// validated on a real device, not in jsdom — the duck-then-cut LOGIC it serves is
// unit-tested against a fake sink in bargeIn.test.ts.

import type { PlaybackSink } from './bargeIn';

// Duck to near-silence on the FIRST sign of barge-in (was 0.15). The deep duck is
// what makes interruption feel instant — the agent effectively stops the moment you
// speak, before the hard cut commits ~cutMs later (bargeIn.ts). On speakers it also
// collapses the agent→mic echo bleed that was making the VAD flicker, which is half
// of why the cut never landed. 0.05 (not 0) keeps a hair of presence so a transient
// (cough) restore isn't a jarring pop. (spec-190 dec-8 barge-in tuning.)
const DEFAULT_DUCK_GAIN = 0.05;
const DEFAULT_DUCK_RAMP_S = 0.05; // ~50ms, matches BargeInController.duckDelayMs
// Sample rate of the raw PCM the server streams (ElevenLabs output_format
// pcm_24000). Keep in sync with DEFAULT_TTS_FORMAT in server elevenlabs-client.ts.
const PCM_PLAYBACK_RATE = 24000;

export class WebAudioPlayback implements PlaybackSink {
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  // Absolute AudioContext time at which the next chunk should start, so chunks
  // play back-to-back without gaps.
  private nextStartAt = 0;
  // ctx.currentTime when the current turn's playback began (for playedMs).
  private turnStartedAt = 0;
  private turnPlaying = false;
  // One-shot callback fired when the scheduled queue has finished playing out.
  // The orchestrator arms this on the FINAL chunk so 'speaking' is held until the
  // user stops hearing the agent — not merely until the last chunk arrives.
  private drainCb: (() => void) | null = null;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  /** Start a fresh assistant turn — reset the schedule + the played clock. */
  startTurn(): void {
    this.drainCb = null; // a new turn supersedes any pending drain of the old one
    this.nextStartAt = this.ctx.currentTime;
    this.turnStartedAt = this.ctx.currentTime;
    this.turnPlaying = true;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  /** Schedule a streamed audio chunk so playback begins before the full response
   *  is synthesized (ac-7 on the consuming side). The chunks are raw 16-bit
   *  little-endian PCM (server output_format pcm_24000): each is self-contained, so
   *  we build an AudioBuffer directly rather than decodeAudioData (which clicks on
   *  partial MP3 chunks). Web Audio resamples the buffer's rate to the context's. */
  enqueue(audio: ArrayBuffer): void {
    // Guard a possible odd trailing byte from a chunk split mid-sample.
    const usableBytes = audio.byteLength - (audio.byteLength % 2);
    if (usableBytes <= 0) return;
    const pcm = new Int16Array(audio, 0, usableBytes / 2);
    const buffer = this.ctx.createBuffer(1, pcm.length, PCM_PLAYBACK_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i];
      channel[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const startAt = Math.max(this.nextStartAt, this.ctx.currentTime);
    src.start(startAt);
    this.nextStartAt = startAt + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      // The last scheduled source has the latest end time, so an empty set here
      // means the queue has truly drained. drainCb is only armed (after the final
      // chunk) by onDrain(); before that this is a no-op.
      if (this.sources.size === 0) this.fireDrain();
    };
  }

  /** Arm a one-shot callback for when the currently-scheduled audio finishes
   *  playing. Fires immediately if nothing is queued. Cleared by flush()/startTurn()
   *  so a barge-in cut or a superseding turn takes precedence. */
  onDrain(cb: () => void): void {
    this.drainCb = cb;
    if (this.sources.size === 0) this.fireDrain();
  }

  private fireDrain(): void {
    const cb = this.drainCb;
    this.drainCb = null;
    cb?.();
  }

  duck(): void {
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(DEFAULT_DUCK_GAIN, now + DEFAULT_DUCK_RAMP_S);
  }

  restore(): void {
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(1, now + DEFAULT_DUCK_RAMP_S);
  }

  /** Hard cut: stop every scheduled source and clear the queue. */
  flush(): void {
    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextStartAt = this.ctx.currentTime;
    this.turnPlaying = false;
    this.drainCb = null; // a hard cut returns to listening via onCut, not drain
  }

  /** Milliseconds of audio actually played in the current turn. Clamped so a cut
   *  during a silent gap can't report more than was scheduled. */
  playedMs(): number {
    if (!this.turnPlaying) return 0;
    const elapsed = (this.ctx.currentTime - this.turnStartedAt) * 1000;
    const scheduled = (this.nextStartAt - this.turnStartedAt) * 1000;
    return Math.max(0, Math.min(elapsed, scheduled));
  }

  dispose(): void {
    this.flush();
    this.gain.disconnect();
    void this.ctx.close();
  }
}
