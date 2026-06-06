// t-2 mic + local VAD wiring (dec-8 / ac-23). Verifies the AEC constraint, that
// capture goes through an injected getUserMedia, that onset/end are surfaced from
// the local engine with NO network call, and the denied-permission path. The real
// Silero AudioWorklet engine is browser glue (validated on a device, not jsdom).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { MicVad, MicPermissionError, micConstraints, type VadEngine } from './micVad';

const AC23 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-23';

function fakeEngine() {
  let captured: ((speaking: boolean) => void) | null = null;
  const engine: VadEngine = {
    start: vi.fn(async (_stream: MediaStream, onSpeech: (s: boolean) => void) => {
      captured = onSpeech;
    }),
    stop: vi.fn(),
  };
  return { engine, emit: (s: boolean) => captured?.(s) };
}

describe('micConstraints (ac-23 — echo cancellation)', () => {
  it('opens the mic with echoCancellation enabled and no video', () => {
    const c = micConstraints();
    const audio = c.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(true);
    expect(c.video).toBe(false);
  });
});

describe('MicVad (ac-23 — local, AEC, no round-trip)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // Detection must be local: assert nothing in the VAD path hits the network.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it('captures with echoCancellation and surfaces local onset/end events', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    const { engine, emit } = fakeEngine();
    const onStart = vi.fn();
    const onEnd = vi.fn();

    const mic = new MicVad({ getUserMedia, engine });
    await mic.start(onStart, onEnd);

    // Opened with AEC on.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((constraints.audio as MediaTrackConstraints).echoCancellation).toBe(true);

    // Engine drives onset/end (the agent's own playback/earcons are stripped by
    // AEC upstream, so they never reach here).
    emit(true);
    emit(false);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);

    // Local detection — no network in the VAD path.
    expect(fetchSpy).not.toHaveBeenCalled();
    tagAc(AC23);
  });

  it('raises MicPermissionError when the mic is denied/unavailable', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const { engine } = fakeEngine();
    const mic = new MicVad({ getUserMedia, engine });
    await expect(mic.start(vi.fn(), vi.fn())).rejects.toBeInstanceOf(MicPermissionError);
    expect(engine.start).not.toHaveBeenCalled();
    tagAc(AC23);
  });
});
