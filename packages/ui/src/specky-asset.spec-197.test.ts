import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-197 Slice 1 (t-1) — the Specky asset's repo home, the bundler-imported
// served copy, and reduced-motion handling. Filesystem-level assertions so a
// drift between the canonical source and the UI copy, a lost reduced-motion
// rule, or a regression to the (unrouted) web-root mechanism fails loudly here.
//
// dec-3 (revised 2026-06-07): Specky is served as a *bundler-imported* asset
// (`import speckyUrl from './assets/specky.svg'` → Vite emits it under
// `/assets/specky-<hash>.svg`, which the LB url-map routes to the static
// bucket). It is NOT a web-root file: the int/prod url-map only routes an
// explicit allowlist of root paths (favicon.svg, robots.txt, /assets/*) to the
// bucket, so `/specky.svg` would fall through to the SPA catch-all and 404.
// The in-view/pill rendering ACs (ac-1/2/6/7/8/9/10 render path) belong to
// Slice 2 (t-2/t-3/t-4) and are covered by component tests there.

const AC_TRANSPARENT_SCALABLE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-3';
const AC_REDUCED_MOTION = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-4';
const AC_CANONICAL_SOURCE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-5';
const AC_QUIET_STATIC = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-8';
const AC_ASSETS_MECHANISM = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-10';
// Implementation ACs from dec-4 / dec-5 (impl-side restatements of ac-5 / ac-4):
const AC_ASSET_HOME = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-11'; // dec-4 canonical dir + bundler UI copy
const AC_RASTER_REGEN = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-12'; // dec-4 reproducible rasters
const AC_REDUCED_MOTION_IMPL = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-13'; // dec-5 static, not hidden

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // packages/ui/src
const UI_ROOT = join(SRC_DIR, '..'); // packages/ui
const REPO_ROOT = join(SRC_DIR, '..', '..', '..'); // repo root

const CANONICAL_SVG = join(REPO_ROOT, 'assets', 'specky', 'specky.svg');
const UI_ASSET_SVG = join(SRC_DIR, 'assets', 'specky.svg'); // bundler-imported
const PUBLIC_SVG = join(UI_ROOT, 'public', 'specky.svg'); // the WRONG (unrouted) place
const CANONICAL_STATIC = join(REPO_ROOT, 'assets', 'specky', 'specky-static.svg');
const UI_STATIC_SVG = join(SRC_DIR, 'assets', 'specky-static.svg'); // quiet-doorway variant
const MAKE_RASTER = join(REPO_ROOT, 'assets', 'specky', 'make_raster.py');
const README = join(REPO_ROOT, 'assets', 'specky', 'README.md');

describe('Specky asset — repo home & bundler-imported copy (spec-197 dec-4 / ac-5)', () => {
  it('specky.svg is the canonical in-repo source under assets/specky/', () => {
    tagAc(AC_CANONICAL_SOURCE);
    tagAc(AC_ASSET_HOME); // ac-11: canonical source set lives under assets/specky/
    expect(existsSync(CANONICAL_SVG)).toBe(true);
    const svg = readFileSync(CANONICAL_SVG, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('a vendored regenerator + README make the asset reproducible in-repo', () => {
    tagAc(AC_CANONICAL_SOURCE);
    tagAc(AC_RASTER_REGEN); // ac-12: rasters regenerate reproducibly via make_raster.py
    tagAc(AC_ASSET_HOME); // ac-11: make_raster.py + README are part of the canonical source set
    expect(existsSync(MAKE_RASTER)).toBe(true);
    const py = readFileSync(MAKE_RASTER, 'utf8');
    expect(py).toContain('specky.gif');
    expect(py).toContain('specky.png');
    expect(existsSync(README)).toBe(true);
  });

  it('the UI copy at src/assets/specky.svg is byte-identical to the source', () => {
    tagAc(AC_CANONICAL_SOURCE);
    tagAc(AC_ASSET_HOME); // ac-11: UI copy is byte-identical + bundler-imported (not public web-root)
    expect(existsSync(UI_ASSET_SVG)).toBe(true);
    const source = readFileSync(CANONICAL_SVG);
    const uiCopy = readFileSync(UI_ASSET_SVG);
    expect(uiCopy.equals(source)).toBe(true);
  });
});

describe('Specky asset — served via /assets/, not the web root (spec-197 dec-3 / ac-10)', () => {
  it('lives under src/assets so the bundler emits it to /assets/ (routed to the bucket)', () => {
    tagAc(AC_ASSETS_MECHANISM);
    expect(existsSync(UI_ASSET_SVG)).toBe(true);
  });

  it('is NOT placed in public/ — the web-root path is not routed to the bucket and would 404', () => {
    tagAc(AC_ASSETS_MECHANISM);
    expect(existsSync(PUBLIC_SVG)).toBe(false);
  });

  it('importable as a URL: Vite client types resolve *.svg imports to a string URL', () => {
    tagAc(AC_ASSETS_MECHANISM);
    // Compile-time guarantee that `import speckyUrl from './assets/specky.svg'`
    // yields a string URL (vite/client ambient types). Asserted at type level;
    // the runtime import is exercised by the Slice 2 component test.
    type SvgImport = typeof import('./assets/specky.svg');
    const _check: SvgImport extends { default: string } ? true : never = true;
    expect(_check).toBe(true);
  });
});

describe('Specky asset — static (quiet-doorway) variant (spec-197 dec-2 / ac-8)', () => {
  it('specky-static.svg exists (canonical + UI copy) and is byte-identical', () => {
    tagAc(AC_CANONICAL_SOURCE);
    tagAc(AC_ASSET_HOME); // ac-11: the static variant is part of the canonical source set + byte-identical UI copy
    expect(existsSync(CANONICAL_STATIC)).toBe(true);
    expect(existsSync(UI_STATIC_SVG)).toBe(true);
    expect(readFileSync(UI_STATIC_SVG).equals(readFileSync(CANONICAL_STATIC))).toBe(true);
  });

  it('the static variant carries the same artwork but NO animation (so the entry stays quiet)', () => {
    tagAc(AC_QUIET_STATIC);
    const still = readFileSync(CANONICAL_STATIC, 'utf8');
    const animated = readFileSync(CANONICAL_SVG, 'utf8');
    // Same character: the distinctive clip-body path + the eyes are present in both.
    expect(still).toContain('M 78 300 L 78 122');
    expect(animated).toContain('M 78 300 L 78 122');
    // Genuinely static: no animation machinery at all.
    expect(still).not.toMatch(/@keyframes/);
    expect(still).not.toMatch(/animation:/);
    expect(still).not.toContain('<style');
    // ...whereas the avatar variant IS animated.
    expect(animated).toMatch(/@keyframes/);
  });
});

describe('Specky asset — reduced motion (spec-197 dec-5 / ac-4)', () => {
  for (const [label, file] of [
    ['canonical source', CANONICAL_SVG],
    ['UI copy', UI_ASSET_SVG],
  ] as const) {
    it(`${label} freezes to a static frame under prefers-reduced-motion (never display:none)`, () => {
      tagAc(AC_REDUCED_MOTION);
      tagAc(AC_REDUCED_MOTION_IMPL); // ac-13: dec-5 impl — static frame, not display:none
      const svg = readFileSync(file, 'utf8');
      expect(svg).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
      const block = svg.slice(svg.indexOf('prefers-reduced-motion'));
      expect(block).toMatch(/animation:\s*none/);
      expect(svg).not.toMatch(/display:\s*none/);
    });
  }
});

describe('Specky asset — transparent & scalable (spec-197 / ac-3, asset side)', () => {
  it('scales losslessly (viewBox) and carries no opaque full-canvas background', () => {
    tagAc(AC_TRANSPARENT_SCALABLE);
    const svg = readFileSync(CANONICAL_SVG, 'utf8');
    expect(svg).toMatch(/viewBox="0 0 240 330"/);
    expect(svg).not.toMatch(/<rect/);
    expect(svg).not.toMatch(/<svg[^>]*background/);
  });
});
