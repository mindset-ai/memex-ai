// t-2 duck-then-cut barge-in — pure logic tests (dec-8 / ac-24). Fake timers
// drive the cut threshold; a recording PlaybackSink + callback spies stand in
// for Web Audio. No mic / AudioContext needed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BargeInController, spokenPrefix, type PlaybackSink, type BargeInCallbacks } from './bargeIn';

const AC24 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-24';

function harness(playedMs = 0) {
  const playback: PlaybackSink & {
    duck: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
  } = {
    duck: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(),
    playedMs: vi.fn(() => playedMs),
  };
  const cb: BargeInCallbacks & {
    abortTts: ReturnType<typeof vi.fn>;
    abortLlm: ReturnType<typeof vi.fn>;
    onCut: ReturnType<typeof vi.fn>;
  } = {
    abortTts: vi.fn(),
    abortLlm: vi.fn(),
    onCut: vi.fn(),
  };
  const ctrl = new BargeInController(playback, cb, { cutMs: 280, restoreMs: 120 });
  return { ctrl, playback, cb };
}

describe('spokenPrefix (ac-24 truncation)', () => {
  it('returns only the characters that had started before the cut', () => {
    // "hi " starts at 0/50/100ms, "there" at 150ms+
    const chars = [...'hi there'];
    const charStartMs = [0, 50, 100, 150, 200, 250, 300, 350];
    expect(spokenPrefix(chars, charStartMs, 120)).toBe('hi ');
    expect(spokenPrefix(chars, charStartMs, 250)).toBe('hi the'); // 'e' starts at exactly 250ms (inclusive)
    expect(spokenPrefix(chars, charStartMs, 10_000)).toBe('hi there');
    expect(spokenPrefix(chars, charStartMs, -1)).toBe('');
  });
});

describe('BargeInController duck-then-cut (ac-24)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ducks immediately on speech onset, without cutting yet', () => {
    const { ctrl, playback, cb } = harness();
    ctrl.startTurn();
    ctrl.onSpeechStart();
    expect(playback.duck).toHaveBeenCalledTimes(1);
    expect(ctrl.state).toBe('ducked');
    vi.advanceTimersByTime(279); // just under the cut threshold
    expect(cb.abortTts).not.toHaveBeenCalled();
    expect(playback.flush).not.toHaveBeenCalled();
  });

  it('restores (no cut) only after SUSTAINED silence — a transient cough/backchannel', () => {
    const { ctrl, playback, cb } = harness();
    ctrl.startTurn();
    ctrl.onSpeechStart();
    vi.advanceTimersByTime(80); // a short blip
    ctrl.onSpeechEnd();
    // A single gap does NOT restore immediately — it arms the restore timer.
    expect(playback.restore).not.toHaveBeenCalled();
    expect(ctrl.state).toBe('ducked');
    vi.advanceTimersByTime(120); // restoreMs of continuous silence → transient confirmed
    expect(playback.restore).toHaveBeenCalledTimes(1);
    expect(ctrl.state).toBe('speaking');
    vi.advanceTimersByTime(500); // the armed cut must have been cancelled
    expect(cb.abortTts).not.toHaveBeenCalled();
    expect(cb.onCut).not.toHaveBeenCalled();
  });

  it('tolerates a brief gap mid-interruption and still cuts (choppy real speech)', () => {
    const { ctrl, playback, cb } = harness(120);
    ctrl.startTurn();
    ctrl.appendChunk({ chars: [...'hi there'], charStartMs: [0, 50, 100, 150, 200, 250, 300, 350] });
    ctrl.onSpeechStart(); // t=0: duck + arm cut(280)
    vi.advanceTimersByTime(100); // t=100
    ctrl.onSpeechEnd(); // gap begins → arm restore(120 → would fire at t=220)
    vi.advanceTimersByTime(80); // t=180, gap=80ms < restoreMs → still ducked, no restore
    expect(playback.restore).not.toHaveBeenCalled();
    ctrl.onSpeechStart(); // speech resumes → cancels restore, cut timer keeps running
    expect(ctrl.state).toBe('ducked');
    vi.advanceTimersByTime(100); // t=280 → the original cut fires
    expect(playback.flush).toHaveBeenCalledTimes(1);
    expect(cb.abortTts).toHaveBeenCalledTimes(1);
    expect(cb.onCut).toHaveBeenCalledWith('hi ');
    expect(ctrl.state).toBe('cut');
    expect(playback.restore).not.toHaveBeenCalled(); // never wrongly restored
    tagAc(AC24);
  });

  it('cuts on sustained speech: flush + abort TTS + abort LLM + truncated turn', () => {
    const { ctrl, playback, cb } = harness(120); // 120ms of audio played at cut
    ctrl.startTurn();
    ctrl.appendChunk({ chars: [...'hi there'], charStartMs: [0, 50, 100, 150, 200, 250, 300, 350] });
    ctrl.onSpeechStart();
    vi.advanceTimersByTime(280); // sustained → cut fires
    expect(playback.flush).toHaveBeenCalledTimes(1);
    expect(cb.abortTts).toHaveBeenCalledTimes(1);
    expect(cb.abortLlm).toHaveBeenCalledTimes(1);
    expect(cb.onCut).toHaveBeenCalledWith('hi '); // only what played by 120ms
    expect(ctrl.state).toBe('cut');
    tagAc(AC24);
  });

  it('tap-to-interrupt cuts immediately (manual fallback)', () => {
    const { ctrl, playback, cb } = harness(50);
    ctrl.startTurn();
    ctrl.appendChunk({ chars: [...'okay'], charStartMs: [0, 50, 100, 150] });
    ctrl.tapInterrupt();
    expect(playback.flush).toHaveBeenCalledTimes(1);
    expect(cb.abortTts).toHaveBeenCalledTimes(1);
    expect(cb.onCut).toHaveBeenCalledWith('ok'); // chars started by 50ms: 'o'(0),'k'(50)
    expect(ctrl.state).toBe('cut');
    tagAc(AC24);
  });

  it('is inert outside a turn — earcons / stray VAD events never duck or cut', () => {
    const { ctrl, playback, cb } = harness();
    // idle (agent not speaking): a VAD onset must do nothing.
    ctrl.onSpeechStart();
    expect(playback.duck).not.toHaveBeenCalled();
    expect(ctrl.state).toBe('idle');
    vi.advanceTimersByTime(1000);
    expect(cb.abortTts).not.toHaveBeenCalled();
    // After the agent finishes a turn, late VAD events are inert too.
    ctrl.startTurn();
    ctrl.endTurn();
    ctrl.onSpeechStart();
    expect(playback.duck).not.toHaveBeenCalled();
    tagAc(AC24);
  });
});
