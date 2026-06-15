import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';
import { phaseColors } from './phaseColors';
import { statusVariant } from '../utils/statusStyles';
import { PhaseTabBar } from './PhaseTabBar';

// spec-252 dec-1 — the Spec-view header phase palette. A DEDICATED token set
// (not the shared statusVariant): specify renders purple, decoupled so the
// shared `warning` consumers (open/review) never recolour. Header-only scope.

const AC_TOKENS = 'mindset-prod/memex-building-itself/specs/spec-252/acs/ac-6';
const AC_PURPLE = 'mindset-prod/memex-building-itself/specs/spec-252/acs/ac-7';
const AC_CONTRAST = 'mindset-prod/memex-building-itself/specs/spec-252/acs/ac-8';

const HERE = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(HERE, '../index.css'), 'utf8');
const tailwindCfg = readFileSync(join(HERE, '../../tailwind.config.js'), 'utf8');
const phaseColorsSrc = readFileSync(join(HERE, './phaseColors.ts'), 'utf8');
const phaseTabBarSrc = readFileSync(join(HERE, './PhaseTabBar.tsx'), 'utf8');

// The four phase container-bg tints + the new specify pill tokens.
const CONTAINER_TOKENS = [
  'phase-draft-container',
  'phase-specify-container',
  'phase-build-container',
  'phase-verify-container',
];
const SPECIFY_PILL_TOKENS = ['phase-specify-bg', 'phase-specify-text', 'phase-specify-border'];

/** Extract the body of a top-level `.light {…}` / `.dark {…}` rule. */
function themeBlock(theme: 'light' | 'dark'): string {
  const m = indexCss.match(new RegExp(`\\.${theme}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`could not find .${theme} block in index.css`);
  return m[1];
}

/** Read a `--color-<name>:` value from a theme block. */
function tokenValue(block: string, name: string): string {
  const m = block.match(new RegExp(`--color-${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --color-${name} not found`);
  return m[1].trim();
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `rgba(r, g, b, a)` or a bare `r g b` triplet into RGBA. */
function parseColor(value: string): RGBA {
  const rgba = value.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const triplet = value.trim().split(/\s+/).map((p) => parseFloat(p));
  return { r: triplet[0], g: triplet[1], b: triplet[2], a: 1 };
}

/** Alpha-composite a (possibly translucent) colour over an opaque background. */
function composite(fg: RGBA, bg: RGBA): RGBA {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: RGBA): number {
  const lin = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two opaque colours. */
function contrast(c1: RGBA, c2: RGBA): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe('phase colour palette (spec-252 dec-1)', () => {
  it('defines the specify pill + per-phase container-bg tokens in BOTH .light and .dark, with no theme.ts import (ac-6)', () => {
    tagAc(AC_TOKENS);
    const light = themeBlock('light');
    const dark = themeBlock('dark');
    for (const token of [...CONTAINER_TOKENS, ...SPECIFY_PILL_TOKENS]) {
      expect(light, `--color-${token} missing from .light`).toContain(`--color-${token}:`);
      expect(dark, `--color-${token} missing from .dark`).toContain(`--color-${token}:`);
    }
    // Tailwind wires each token so components consume it via the token class.
    for (const token of [...CONTAINER_TOKENS, ...SPECIFY_PILL_TOKENS]) {
      expect(tailwindCfg, `tailwind.config missing ${token}`).toContain(`--color-${token}`);
    }
    // No hardcoded hex in the helper, and the charts-only insights palette
    // (std-27) is not pulled into the header colour path.
    expect(phaseColorsSrc).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(phaseColorsSrc).not.toContain('insights/theme');
    expect(phaseTabBarSrc).not.toContain('insights/theme');
  });

  it('routes specify→purple and build→blue, verify→green, draft→grey — without touching the shared statusVariant (ac-7)', () => {
    tagAc(AC_PURPLE);
    // The pill reading is purple → blue → green; draft stays grey.
    expect(phaseColors('specify')!.pill).toContain('bg-phase-specify-bg');
    expect(phaseColors('specify')!.pill).not.toContain('warning');
    expect(phaseColors('build')!.pill).toContain('bg-phase-build-bg');
    expect(phaseColors('verify')!.pill).toContain('bg-phase-verify-bg');
    // draft has no Figma hue yet → keeps the neutral status token.
    expect(phaseColors('draft')!.pill).toContain('bg-status-neutral-bg');
    // spec-286 gave `done` a neutral GREY pill (no longer null), but spec-252's
    // guarantee still holds: done gets no coloured CONTAINER wash — its container
    // stays empty, so the DocDocument header surface is unchanged at done.
    expect(phaseColors('done')!.pill).toContain('bg-status-neutral-bg');
    expect(phaseColors('done')!.container).toBe('');
    // The shared statusVariant is untouched: specify/review/open stay amber, so
    // board column headers and issue badges do not recolour.
    expect(statusVariant('specify')).toBe('warning');
    expect(statusVariant('open')).toBe('warning');
    // Rendered: the current specify pill wears the purple token.
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={() => {}} />);
    const specifyTab = screen
      .getAllByRole('tab')
      .find((t) => t.getAttribute('data-tab') === 'specify')!;
    expect(specifyTab).toHaveAttribute('data-current', 'true');
    expect(specifyTab.className).toContain('bg-phase-specify-bg');
    expect(specifyTab.className).not.toContain('bg-status-warning-bg');
  });

  it('meets WCAG AA contrast for every coloured pill and container in both modes (ac-8)', () => {
    tagAc(AC_CONTRAST);
    // The hue-bearing pills (draft keeps the AA-safe neutral status token).
    const PILL_PHASES = ['specify', 'build', 'verify'] as const;
    for (const theme of ['light', 'dark'] as const) {
      const block = themeBlock(theme);
      const page = parseColor(tokenValue(block, 'page'));
      const textPrimary = parseColor(tokenValue(block, 'text-primary'));

      // Each pill: pill text on the (translucent) pill bg, composited over the
      // page. Small uppercase text → AA threshold 4.5. A hue @ 80% over the dark
      // page is a mid-tone, so this is the binding check in dark mode.
      for (const phase of PILL_PHASES) {
        const pillBg = composite(parseColor(tokenValue(block, `phase-${phase}-bg`)), page);
        const pillText = composite(parseColor(tokenValue(block, `phase-${phase}-text`)), pillBg);
        expect(
          contrast(pillText, pillBg),
          `${phase} pill text/bg contrast in ${theme}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Each container tint: body text (text-primary) on the container
      // composited over the page. AA 4.5.
      for (const token of CONTAINER_TOKENS) {
        const containerBg = composite(parseColor(tokenValue(block, token)), page);
        expect(
          contrast(textPrimary, containerBg),
          `${token} vs text-primary contrast in ${theme}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
