// spec-190 t-8 (dec-5 / ac-31) — earcons (start, ack ping, end, error). All audio
// the guide produces is emitted via APP playback only (ac-31) — there is no
// system-notification / OS-bell path. These are short synthesized tones (WebAudio
// oscillator), so no audio asset files ship; the ack `ping` is the one that
// matters most — it plays the instant speech ends, masking retrieval latency
// (dec-6), and the pill's blip is synced to it (ac-29).
//
// The engine is an interface so the session provider can be unit-tested with a
// recording fake (assert which earcons fired) without real Web Audio.

import type { Earcon } from './voiceSessionModel';

export interface EarconPlayer {
  play(earcon: Earcon): void;
  /** Release the AudioContext (session end). */
  dispose(): void;
}

// Tone recipe per earcon: [frequency Hz, duration ms]. Distinct, short, non-musical
// enough to read as UI feedback rather than content.
const TONES: Record<Earcon, { freq: number; ms: number }> = {
  start: { freq: 660, ms: 120 }, // rising "session on"
  ping: { freq: 880, ms: 90 }, // bright, quick ack
  end: { freq: 440, ms: 140 }, // lower "session off"
  error: { freq: 220, ms: 200 }, // low buzz
};

/** Real WebAudio earcon player. Lazily creates one shared AudioContext. */
export class WebAudioEarconPlayer implements EarconPlayer {
  private ctx: AudioContext | null = null;

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  play(earcon: Earcon): void {
    const { freq, ms } = TONES[earcon];
    const ctx = this.context();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    // Short envelope to avoid clicks.
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + ms / 1000 + 0.02);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** No-op player (tests / SSR). */
export const noopEarconPlayer: EarconPlayer = {
  play: () => {},
  dispose: () => {},
};
