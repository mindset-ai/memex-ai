// spec-386 (sus-4 / spec-357 dec-1): the UI vitest coverage floor was stepped
// up toward the ~50%-branch target and the new thresholds were locked into
// packages/ui/vitest.config.ts. This test pins the locked-in floor so a future
// edit that quietly lowers the gate is caught, and tags the implementation AC
// (ac-4) — the observable outcome being "the raised gate is in place and the
// suite clears it" (the green coverage run that produced these numbers is the
// empirical proof; this asserts the config that encodes it).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_FLOOR_RAISED =
  'mindset-prod/memex-building-itself/specs/spec-386/acs/ac-4';

// Read the actual config source so the assertion tracks the file, not a copy.
const configPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../vitest.config.ts',
);
const configSrc = readFileSync(configPath, 'utf8');

function thresholdValue(metric: string): number {
  // Match e.g. `branches: 52,` inside the thresholds block.
  const m = configSrc.match(new RegExp(`${metric}:\\s*(\\d+)`));
  return m ? Number(m[1]) : Number.NaN;
}

describe('spec-386: UI coverage floor stepped toward ~50% branch', () => {
  it('locks the raised thresholds (60/58/52/58) into vitest.config.ts', () => {
    tagAc(AC_FLOOR_RAISED);
    expect(thresholdValue('lines')).toBe(60);
    expect(thresholdValue('functions')).toBe(58);
    expect(thresholdValue('branches')).toBe(52);
    expect(thresholdValue('statements')).toBe(58);
  });

  it('clears the spec-357 dec-1 mid target of ~50% branch with margin', () => {
    tagAc(AC_FLOOR_RAISED);
    // Branch floor is at/above 50 — the strategic target — and well above the
    // stale 23 the gate used to sit at.
    expect(thresholdValue('branches')).toBeGreaterThanOrEqual(50);
    expect(thresholdValue('branches')).toBeGreaterThan(23);
  });
});
