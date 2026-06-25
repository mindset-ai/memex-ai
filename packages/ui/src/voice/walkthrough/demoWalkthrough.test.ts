// spec-211 t-3: the client tour sequencer (runDemoTour) — the speech-synced,
// one-phase-at-a-time loop that replaces the burst.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { runDemoTour, type DemoTourDeps } from './demoWalkthrough';
import { REVEAL_PHASES } from '../../hooks/useHandholdReveal';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-211/acs/ac-${n}`;

function harness(overrides: Partial<DemoTourDeps> = {}) {
  const log: string[] = [];
  let active = true;
  const deps: DemoTourDeps = {
    phases: REVEAL_PHASES,
    isActive: () => active,
    resetReveal: () => log.push('reset'),
    advanceReveal: () => log.push('advance'),
    openPath: (p) => `/specs/${p}`,
    navigate: (path) => log.push(`nav:${path}`),
    boardPath: '/board',
    narratePhase: async (p) => {
      log.push(`narrate:${p}:start`);
      await Promise.resolve();
      log.push(`narrate:${p}:end`);
    },
    pause: async () => {
      log.push('pause');
    },
    boardPauseMs: 0,
    ...overrides,
  };
  return { log, deps, setActive: (v: boolean) => (active = v) };
}

describe('runDemoTour — speech-synced per-phase loop (spec-211)', () => {
  it('opens each demo spec before narrating it, and ends on the board (ac-1/ac-3/ac-12)', async () => {
    const { log, deps } = harness();
    await runDemoTour(deps);

    // Draft: opened (navigated) before its narration begins.
    expect(log.indexOf('nav:/specs/draft')).toBeLessThan(log.indexOf('narrate:draft:start'));
    // Every phase opens before it narrates.
    for (const p of REVEAL_PHASES) {
      expect(log.indexOf(`nav:/specs/${p}`)).toBeGreaterThanOrEqual(0);
      expect(log.indexOf(`nav:/specs/${p}`)).toBeLessThan(log.indexOf(`narrate:${p}:start`));
    }
    // Ends back on the board (dec-3).
    expect(log[log.length - 1]).toBe('nav:/board');
    tagAc(AC(1));
    tagAc(AC(3));
    // ac-4: every phase is opened (its detail), and the opened path matches the
    // phase being narrated — asserted by the open-before-narrate loop above.
    tagAc(AC(4));
    tagAc(AC(12));
  });

  it('advances exactly one phase at a time, only AFTER the prior narration finishes — no burst (ac-2/ac-9)', async () => {
    const { log, deps } = harness();
    await runDemoTour(deps);

    // The first advance (into specify) must come AFTER draft's narration ENDED.
    const firstAdvance = log.indexOf('advance');
    expect(firstAdvance).toBeGreaterThan(log.indexOf('narrate:draft:end'));

    // No two advances are adjacent / batched: between consecutive advances there is
    // always a completed narration. Exactly 4 advances (draft is opened, not advanced).
    const advances = log.filter((e) => e === 'advance');
    expect(advances).toHaveLength(REVEAL_PHASES.length - 1);
    // Each advance is preceded by the previous phase's narrate:end.
    REVEAL_PHASES.slice(1).forEach((p, i) => {
      const prev = REVEAL_PHASES[i]!; // phase before p
      const advanceIdx = nthIndex(log, 'advance', i + 1);
      expect(advanceIdx).toBeGreaterThan(log.indexOf(`narrate:${prev}:end`));
      expect(advanceIdx).toBeLessThan(log.indexOf(`narrate:${p}:start`));
    });
    tagAc(AC(2));
    tagAc(AC(9));
  });

  it('runs automatically through all five phases in order (ac-5/ac-13)', async () => {
    const { log, deps } = harness();
    await runDemoTour(deps);
    const narrated = log.filter((e) => e.endsWith(':start')).map((e) => e.split(':')[1]);
    expect(narrated).toEqual([...REVEAL_PHASES]);
    tagAc(AC(5));
    tagAc(AC(13));
  });

  it('halts immediately when the session is stopped mid-tour — no further advance/open/board-nav (ac-14)', async () => {
    const h = harness();
    // Stop the session at the end of the draft narration.
    h.deps.narratePhase = async (p) => {
      h.log.push(`narrate:${p}:start`);
      await Promise.resolve();
      h.log.push(`narrate:${p}:end`);
      if (p === 'draft') h.setActive(false);
    };
    await runDemoTour(h.deps);

    // Draft ran; nothing after it.
    expect(h.log).toContain('narrate:draft:start');
    expect(h.log.filter((e) => e === 'advance')).toHaveLength(0); // never advanced
    expect(h.log.some((e) => e.startsWith('narrate:specify'))).toBe(false);
    // The end-of-tour board nav is also suppressed (only the per-phase opens ran).
    expect(h.log[h.log.length - 1]).toBe('narrate:draft:end');
    tagAc(AC(14));
  });

  it('does nothing if the session is already inactive when invoked', async () => {
    const h = harness({ isActive: () => false });
    await runDemoTour(h.deps);
    expect(h.log).toEqual([]);
  });
});

function nthIndex(arr: string[], value: string, n: number): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === value && ++count === n) return i;
  }
  return -1;
}
