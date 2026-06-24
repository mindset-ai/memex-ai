// spec-390 (spec-388 dec-1, workstream A): the UI coverage gate must MEASURE
// src/pages/** (previously invisible — ~32% of UI test effort) and BLOCK on
// TIERED per-dir floors. This pins the config so a future quiet edit that drops
// pages from the include, or flattens the tiers, is caught.
//
// Critically, it also re-asserts the spec-357/spec-386 GLOBAL floor (60/58/52/58)
// stays the FIRST thresholds block — its sibling guard
// (coverage-threshold-floor.spec-386.test.ts) regex-matches the first occurrence
// of each metric, so the global must remain above the per-glob tiers. spec-390
// deliberately does NOT re-raise the UI numbers.
//
// The "gate clears / gate blocks" proofs are the real `test:coverage` runs
// exercised during the spec-390 build (recorded in the QA report); this source
// guard pins the config those runs enforce. Tagged to spec-390 ac-7.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_UI_TIERS = 'mindset-prod/memex-building-itself/specs/spec-390/acs/ac-7';
const AC_UI_BLOCKS = 'mindset-prod/memex-building-itself/specs/spec-390/acs/ac-8';

const configSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../vitest.config.ts'),
  'utf8',
);
const coverageBlock = configSrc.slice(configSrc.indexOf('coverage:'));

/** Metrics of one per-glob threshold object. */
function tierFor(glob: string): Record<string, number> {
  const anchor = coverageBlock.indexOf(`'${glob}'`);
  const slice = coverageBlock.slice(anchor, anchor + 200);
  const grab = (m: string) => {
    const r = slice.match(new RegExp(`${m}:\\s*(\\d+)`));
    return r ? Number(r[1]) : Number.NaN;
  };
  return {
    lines: grab('lines'),
    functions: grab('functions'),
    branches: grab('branches'),
    statements: grab('statements'),
  };
}

describe('spec-390 ac-7: UI coverage include measures pages/**', () => {
  it('adds src/pages/** to the include alongside the existing dirs', () => {
    tagAc(AC_UI_TIERS);
    expect(coverageBlock).toContain("'src/pages/**/*.{ts,tsx}'");
    // the originals are still there — pages is additive, not a replacement
    for (const dir of ['components', 'hooks', 'api', 'utils', 'agent']) {
      expect(coverageBlock).toContain(`'src/${dir}/**/*.{ts,tsx}'`);
    }
  });
});

describe('spec-390 ac-7: the spec-357/spec-386 global floor stays first + unchanged', () => {
  it('keeps the global default at 60/58/52/58 as the FIRST metrics in the block', () => {
    tagAc(AC_UI_TIERS);
    // First occurrence of each metric (what the spec-386 guard reads) — must be
    // the global floor, before any per-glob tier raises them.
    const firstLines = coverageBlock.indexOf('lines:');
    const firstUtils = coverageBlock.indexOf("'src/utils/**'");
    expect(firstLines).toBeGreaterThan(0);
    expect(firstLines).toBeLessThan(firstUtils); // global precedes the tiers
    const head = coverageBlock.slice(0, firstUtils);
    expect(head).toMatch(/lines:\s*60/);
    expect(head).toMatch(/functions:\s*58/);
    expect(head).toMatch(/branches:\s*52/);
    expect(head).toMatch(/statements:\s*58/);
  });
});

describe('spec-390 ac-7: UI thresholds are tiered per-glob at the honest baseline', () => {
  it('holds utils at the high logic tier (90/88/75/90)', () => {
    tagAc(AC_UI_TIERS);
    expect(tierFor('src/utils/**')).toEqual({
      lines: 90,
      functions: 88,
      branches: 75,
      statements: 90,
    });
  });

  it('sets the newly-included pages floor (70/64/58/68)', () => {
    tagAc(AC_UI_TIERS);
    expect(tierFor('src/pages/**')).toEqual({
      lines: 70,
      functions: 64,
      branches: 58,
      statements: 68,
    });
  });

  it('records the api drift as a deliberate near-zero floor (10/10/8/10)', () => {
    tagAc(AC_UI_TIERS);
    expect(tierFor('src/api/**')).toEqual({
      lines: 10,
      functions: 10,
      branches: 8,
      statements: 10,
    });
  });

  it('sets the components/hooks/agent ratchet floors', () => {
    tagAc(AC_UI_TIERS);
    expect(tierFor('src/components/**')).toEqual({
      lines: 60,
      functions: 58,
      branches: 52,
      statements: 58,
    });
    expect(tierFor('src/hooks/**')).toEqual({
      lines: 58,
      functions: 65,
      branches: 44,
      statements: 55,
    });
    expect(tierFor('src/agent/**')).toEqual({
      lines: 78,
      functions: 72,
      branches: 58,
      statements: 75,
    });
  });
});

// spec-390 ac-8 — the UI gate BLOCKS, not merely reports. The empirical proof is
// the real `test:coverage` runs exercised during the build (recorded in the QA
// report): the suite exits 0 at these floors, and exits NON-ZERO when a tier is
// over-raised (the utils-branches=99 over-raise produced "Coverage for branches
// (81.33%) does not meet 'src/utils/**' threshold (99%)" and a status-1 exit).
// This guard pins the structural precondition: every UI tier carries non-zero
// floors so vitest's checkThresholds enforces rather than no-ops.
describe('spec-390 ac-8: every UI tier is enforcing (non-zero), so the gate can block', () => {
  it('all per-glob floors are strictly positive on all four metrics', () => {
    tagAc(AC_UI_BLOCKS);
    const tiers = [
      tierFor('src/utils/**'),
      tierFor('src/pages/**'),
      tierFor('src/components/**'),
      tierFor('src/hooks/**'),
      tierFor('src/agent/**'),
      tierFor('src/api/**'),
    ];
    for (const t of tiers) {
      expect(t.lines).toBeGreaterThan(0);
      expect(t.functions).toBeGreaterThan(0);
      expect(t.branches).toBeGreaterThan(0);
      expect(t.statements).toBeGreaterThan(0);
    }
  });
});
