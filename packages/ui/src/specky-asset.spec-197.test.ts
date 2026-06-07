import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-197 Slice 1 (t-1) — the Specky asset's repo home, served copy, and
// reduced-motion handling. Filesystem-level assertions so a drift between the
// canonical source and the served copy, or a lost reduced-motion rule, fails
// loudly here. The in-view/pill rendering ACs (ac-1/2/6/7/8/9/10) belong to
// Slice 2 (t-2/t-3/t-4) and are covered by component tests there.

const AC_TRANSPARENT_SCALABLE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-3';
const AC_REDUCED_MOTION = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-4';
const AC_CANONICAL_SOURCE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-5';

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // packages/ui/src
const UI_ROOT = join(SRC_DIR, '..'); // packages/ui
const REPO_ROOT = join(SRC_DIR, '..', '..', '..'); // repo root

const CANONICAL_SVG = join(REPO_ROOT, 'assets', 'specky', 'specky.svg');
const SERVED_SVG = join(UI_ROOT, 'public', 'specky.svg');
const MAKE_RASTER = join(REPO_ROOT, 'assets', 'specky', 'make_raster.py');
const README = join(REPO_ROOT, 'assets', 'specky', 'README.md');

describe('Specky asset — repo home & served copy (spec-197 dec-4 / ac-5)', () => {
  it('specky.svg is the canonical in-repo source under assets/specky/', () => {
    tagAc(AC_CANONICAL_SOURCE);
    expect(existsSync(CANONICAL_SVG)).toBe(true);
    const svg = readFileSync(CANONICAL_SVG, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('a vendored regenerator + README make the asset reproducible in-repo', () => {
    tagAc(AC_CANONICAL_SOURCE);
    // make_raster.py regenerates the raster fallbacks reproducibly from the SVG.
    expect(existsSync(MAKE_RASTER)).toBe(true);
    const py = readFileSync(MAKE_RASTER, 'utf8');
    expect(py).toContain('specky.gif');
    expect(py).toContain('specky.png');
    expect(existsSync(README)).toBe(true);
  });

  it('the served copy at packages/ui/public/specky.svg is byte-identical to the source', () => {
    tagAc(AC_CANONICAL_SOURCE);
    expect(existsSync(SERVED_SVG)).toBe(true);
    const source = readFileSync(CANONICAL_SVG);
    const served = readFileSync(SERVED_SVG);
    expect(served.equals(source)).toBe(true);
  });
});

describe('Specky asset — reduced motion (spec-197 dec-5 / ac-4)', () => {
  for (const [label, file] of [
    ['canonical source', CANONICAL_SVG],
    ['served copy', SERVED_SVG],
  ] as const) {
    it(`${label} freezes to a static frame under prefers-reduced-motion (never display:none)`, () => {
      tagAc(AC_REDUCED_MOTION);
      const svg = readFileSync(file, 'utf8');
      // The media query exists and zeroes the animations on the animated groups.
      expect(svg).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
      const block = svg.slice(svg.indexOf('prefers-reduced-motion'));
      expect(block).toMatch(/animation:\s*none/);
      // Degrades to a static frame, NOT hidden — the affordance stays discoverable.
      expect(svg).not.toMatch(/display:\s*none/);
    });
  }
});

describe('Specky asset — transparent & scalable (spec-197 / ac-3, asset side)', () => {
  it('scales losslessly (viewBox) and carries no opaque full-canvas background', () => {
    tagAc(AC_TRANSPARENT_SCALABLE);
    const svg = readFileSync(CANONICAL_SVG, 'utf8');
    // A viewBox means the asset scales crisply at any size.
    expect(svg).toMatch(/viewBox="0 0 240 330"/);
    // Transparency: no background <rect> painting the whole canvas, and no
    // explicit background fill on the root <svg>.
    expect(svg).not.toMatch(/<rect/);
    expect(svg).not.toMatch(/<svg[^>]*background/);
  });
});
