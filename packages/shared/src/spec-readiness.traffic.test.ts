// spec-189 t-1 — the traffic-driven phase-advancement matrix, locked cell by cell.
//
// **ac-2** (scope) — gated transition rules: build-class traffic advances but
// never regresses verify → build; verify-class traffic never advances a Spec
// into verify except out of draft or reopening from done; done reopens to the
// traffic's phase.
// **ac-3** (scope) — ALL gating logic lives in one pure function,
// `nextPhaseForTraffic` in spec-readiness.ts, testable in complete isolation.
// **ac-6** — class → phase mapping: specify-class and verify-class are
// distinct inputs and the function consumes the class, never a tool name.
// **ac-7** — draft moves on any class; from specify only build-class
// advances; no auto-regression except reopening from done.
//
// The table below IS the spec-189 matrix. Every (phase × class) cell is
// asserted — 5 phases × 4 classes (specify / build / verify / null) = 20
// cells. A change to any gated condition fails here first.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  nextPhaseForTraffic,
  type SpecPhase,
  type TrafficClass,
} from './spec-readiness.js';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-189';
const AC2 = `${SPEC}/acs/ac-2`;
const AC3 = `${SPEC}/acs/ac-3`;
const AC6 = `${SPEC}/acs/ac-6`;
const AC7 = `${SPEC}/acs/ac-7`;

// The full matrix, transcribed from spec-189's Overview. Row order mirrors the
// lifecycle; column order is specify / build / verify / query(null).
const MATRIX: Array<{
  current: SpecPhase;
  traffic: TrafficClass;
  next: SpecPhase;
}> = [
  // draft is special: ANY classified traffic re-homes it (dec-2)
  { current: 'draft', traffic: 'specify', next: 'specify' },
  { current: 'draft', traffic: 'build', next: 'build' },
  { current: 'draft', traffic: 'verify', next: 'verify' },
  { current: 'draft', traffic: null, next: 'draft' },
  // specify: only build-class traffic advances
  { current: 'specify', traffic: 'specify', next: 'specify' },
  { current: 'specify', traffic: 'build', next: 'build' },
  { current: 'specify', traffic: 'verify', next: 'specify' },
  { current: 'specify', traffic: null, next: 'specify' },
  // build: nothing moves it — entering verify is never traffic-driven
  { current: 'build', traffic: 'specify', next: 'build' },
  { current: 'build', traffic: 'build', next: 'build' },
  { current: 'build', traffic: 'verify', next: 'build' },
  { current: 'build', traffic: null, next: 'build' },
  // verify: nothing moves it — no regression back to build (dec-1 narrative)
  { current: 'verify', traffic: 'specify', next: 'verify' },
  { current: 'verify', traffic: 'build', next: 'verify' },
  { current: 'verify', traffic: 'verify', next: 'verify' },
  { current: 'verify', traffic: null, next: 'verify' },
  // done is reopenable by activity: traffic moves it BACK to the class phase
  { current: 'done', traffic: 'specify', next: 'specify' },
  { current: 'done', traffic: 'build', next: 'build' },
  { current: 'done', traffic: 'verify', next: 'verify' },
  { current: 'done', traffic: null, next: 'done' },
];

describe('spec-189 t-1: nextPhaseForTraffic — the full transition matrix', () => {
  it.each(MATRIX)(
    '($current, $traffic) → $next',
    ({ current, traffic, next }) => {
      tagAc(AC2);
      tagAc(AC3);
      expect(nextPhaseForTraffic(current, traffic)).toBe(next);
    },
  );

  it('draft moves on every traffic class; specify advances only on build-class (ac-7)', () => {
    tagAc(AC7);
    // draft → the class's phase, for each class
    expect(nextPhaseForTraffic('draft', 'specify')).toBe('specify');
    expect(nextPhaseForTraffic('draft', 'build')).toBe('build');
    expect(nextPhaseForTraffic('draft', 'verify')).toBe('verify');
    // specify: build-class is the only mover
    expect(nextPhaseForTraffic('specify', 'build')).toBe('build');
    expect(nextPhaseForTraffic('specify', 'specify')).toBe('specify');
    expect(nextPhaseForTraffic('specify', 'verify')).toBe('specify');
  });

  it('never auto-regresses except reopening from done (ac-7)', () => {
    tagAc(AC7);
    const phases: SpecPhase[] = ['draft', 'specify', 'build', 'verify', 'done'];
    const classes: TrafficClass[] = ['specify', 'build', 'verify', null];
    const order: Record<SpecPhase, number> = {
      draft: 0,
      specify: 1,
      build: 2,
      verify: 3,
      done: 4,
    };
    for (const current of phases) {
      for (const traffic of classes) {
        const next = nextPhaseForTraffic(current, traffic);
        if (current !== 'done' && current !== 'draft') {
          // between the open ends, motion is forward-only
          expect(order[next]).toBeGreaterThanOrEqual(order[current]);
        }
      }
    }
  });

  it('consumes a TrafficClass, never a tool name — specify and verify are distinct inputs (ac-6)', () => {
    tagAc(AC6);
    // The same Spec state reacts differently to the two classes that dec-1
    // split: specify-class moves a draft to specify; verify-class moves the
    // same draft to verify. The function signature admits only the class.
    expect(nextPhaseForTraffic('draft', 'specify')).toBe('specify');
    expect(nextPhaseForTraffic('draft', 'verify')).toBe('verify');
    // and query-class (null) is inert everywhere
    expect(nextPhaseForTraffic('draft', null)).toBe('draft');
    expect(nextPhaseForTraffic('done', null)).toBe('done');
  });
});
