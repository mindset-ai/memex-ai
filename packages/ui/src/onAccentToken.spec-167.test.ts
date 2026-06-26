import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

// spec-167 — verify-phase coverage for the `on-accent` foreground token.
// These assert the SOURCE of truth (the token definitions + the single consumer)
// and compute the WCAG contrast the token actually delivers. The deployed-env
// proof of ac-6 lives in the smoke suite (oauth-consent-allow-button.smoke.test.ts).
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-167/acs/ac-${n}`;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(SRC_DIR, 'index.css'), 'utf8');

// spec-290 (dec-1): Tailwind v4 is CSS-first — there is no tailwind.config.js.
// Tokens live in the `@theme` block (mapping `--color-<name>` → its channel) and
// the raw per-theme values live under `--ch-*` in the .dark / .light blocks.

/** Extract the body of a `.dark { … }` / `.light { … }` theme block. */
function themeBlock(theme: 'dark' | 'light'): string {
  const m = indexCss.match(new RegExp(`\\.${theme}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`could not find .${theme} block in index.css`);
  return m[1];
}

/** Read a `--ch-*: R G B;` channel custom property out of a block as [r,g,b]. */
function rgbVar(block: string, name: string): [number, number, number] {
  const m = block.match(new RegExp(`--ch-${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
  if (!m) throw new Error(`could not find --ch-${name} in block`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG 2.x relative luminance + contrast ratio. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const dark = themeBlock('dark');
const light = themeBlock('light');

describe('spec-167: on-accent foreground token', () => {
  it('ac-1: Allow-button text clears WCAG AA (≥4.5:1) against its accent fill in both themes', () => {
    tagAc(AC(1));
    const darkRatio = contrast(rgbVar(dark, 'on-accent'), rgbVar(dark, 'accent'));
    const lightRatio = contrast(rgbVar(light, 'on-accent'), rgbVar(light, 'accent'));
    expect(darkRatio).toBeGreaterThanOrEqual(4.5);
    expect(lightRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('ac-2: the token is reusable — defined in index.css AND exposed as a Tailwind colour (not hard-coded on the component)', () => {
    tagAc(AC(2));
    // Channel defined per theme (both blocks)…
    expect(dark).toMatch(/--ch-on-accent:/);
    expect(light).toMatch(/--ch-on-accent:/);
    // …and surfaced as a utility-generating colour token via @theme (v4 CSS-first).
    expect(indexCss).toMatch(
      /--color-on-accent:\s*rgb\(var\(--ch-on-accent\)\)/,
    );
    // Not hard-coded on the consent component.
    const oauth = readFileSync(join(SRC_DIR, 'pages', 'OauthAuthorize.tsx'), 'utf8');
    expect(oauth).toContain('text-on-accent');
    expect(oauth).not.toMatch(/style=\{\{[^}]*color:/); // no inline colour override
  });

  it('ac-3: no regression — `text-on-accent` is limited to its known consumers and the existing accent values are unchanged', () => {
    tagAc(AC(3));
    // Existing accent fills untouched (blue-400 dark / blue-600 light).
    expect(rgbVar(dark, 'accent')).toEqual([96, 165, 250]);
    expect(rgbVar(light, 'accent')).toEqual([37, 99, 235]);
    // text-on-accent is a deliberately REUSABLE token (ac-2). Its known, intended
    // consumers render text on a `bg-accent` fill — the exact contrast case the token
    // solves: the OAuth Allow button (spec-167), the spec-171 PricingCard "Current plan"
    // badge, and the spec-336 Home-onboarding primary buttons (identity "Continue",
    // create-spec "Create spec in Memex"). The set stays CLOSED so an accidental new
    // consumer (or a hard-coded colour) still trips this guard.
    const files = readdirSync(SRC_DIR, { recursive: true }) as string[];
    const consumers = files
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
      .filter((f) => readFileSync(join(SRC_DIR, f), 'utf8').includes('text-on-accent'))
      .map((f) => f.split(sep).join('/'))
      .sort();
    // spec-421: CreateFirstSpecStep.tsx added as a new text-on-accent consumer
    // (blue "Create your first spec" CTA button); CreateSpecStep.tsx's Stage-2
    // "Create spec in Memex" button was removed, so it exits the set.
    expect(consumers).toEqual(
      [
        'components/home/CreateFirstSpecStep.tsx',
        'components/home/IdentityStep.tsx',
        'components/upgrade/PricingCard.tsx',
        'pages/OauthAuthorize.tsx',
      ].sort(),
    );
  });

  it('ac-4: --color-on-accent is slate-900 in .dark and white in .light', () => {
    tagAc(AC(4));
    expect(rgbVar(dark, 'on-accent')).toEqual([15, 23, 42]);
    expect(rgbVar(light, 'on-accent')).toEqual([255, 255, 255]);
  });

  it('ac-5: the @theme block exposes `on-accent` so the `text-on-accent` utility resolves', () => {
    tagAc(AC(5));
    // v4 CSS-first: the token is declared in @theme as --color-on-accent,
    // mapped to its channel, which is what makes `text-on-accent` generate.
    expect(indexCss).toMatch(
      /--color-on-accent:\s*rgb\(var\(--ch-on-accent\)\)/,
    );
  });
});
