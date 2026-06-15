import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-290 (dec-1 / ac-8) — baked-opacity tokens (alpha pre-mixed into the
// channel value) must NOT carry a `/alpha` modifier. In v3 the modifier was a
// silent no-op; v4 likewise drops it on a bare-var token — so a `/N` here is
// dead, misleading code (a reader expects translucency that never happens).
// This guard keeps them out for good. The alpha-CAPABLE tokens (surface, text-*,
// accent, …) legitimately use /alpha → v4 color-mix(in srgb), parity-exact with
// v3's rgb(var(--ch) / x); the build's 0-bare-channel check + t-7 visual pass
// cover that half of ac-8.
const AC8 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-8';

const SRC = dirname(fileURLToPath(import.meta.url));

const BAKED = [
  'panel',
  'overlay',
  'edge-subtle',
  'chip', // chip is baked; chip-text / chip-border are alpha-capable
  'status-(?:warning|success|info|danger|neutral)-bg',
  'phase-(?:specify|build|verify)-bg',
  'phase-(?:draft|specify|build|verify)-container',
].join('|');
// A utility prefix, a baked token, then a `/<number>` opacity modifier.
const BAKED_ALPHA = new RegExp(
  `\\b(?:bg|border|divide|ring|from|to|via|fill|stroke|outline|shadow)-(?:${BAKED})/\\d+`,
  'g',
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

describe('spec-290: baked-opacity tokens reject /alpha modifiers (ac-8)', () => {
  it('ac-8: no source carries a /alpha modifier on a baked-opacity token', () => {
    tagAc(AC8);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('tailwindBakedAlpha.spec-290.test.ts')) continue; // this file names them
      const matches = readFileSync(file, 'utf8').match(BAKED_ALPHA);
      if (matches) offenders.push(`${file.replace(SRC, 'src')}: ${matches.join(', ')}`);
    }
    expect(offenders, `baked-token /alpha modifiers found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
