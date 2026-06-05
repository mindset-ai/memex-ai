import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-167 — verify-phase coverage for the `on-accent` foreground token.
// These assert the SOURCE of truth (the token definitions + the single consumer)
// and compute the WCAG contrast the token actually delivers. The deployed-env
// proof of ac-6 lives in the smoke suite (oauth-consent-allow-button.smoke.test.ts).
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-167/acs/ac-${n}`;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(SRC_DIR, 'index.css'), 'utf8');
const tailwindConfig = readFileSync(
  join(SRC_DIR, '..', 'tailwind.config.js'),
  'utf8',
);

/** Extract the body of a `.dark { … }` / `.light { … }` theme block. */
function themeBlock(theme: 'dark' | 'light'): string {
  const m = indexCss.match(new RegExp(`\\.${theme}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`could not find .${theme} block in index.css`);
  return m[1];
}

/** Read a `--color-*: R G B;` custom property out of a block as [r,g,b]. */
function rgbVar(block: string, name: string): [number, number, number] {
  const m = block.match(new RegExp(`--color-${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
  if (!m) throw new Error(`could not find --color-${name} in block`);
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
    // Defined per theme (a real token, both blocks)…
    expect(dark).toMatch(/--color-on-accent:/);
    expect(light).toMatch(/--color-on-accent:/);
    // …and surfaced as a utility-generating colour token.
    expect(tailwindConfig).toMatch(
      /'on-accent':\s*'rgb\(var\(--color-on-accent\) \/ <alpha-value>\)'/,
    );
    // Not hard-coded on the consent component.
    const oauth = readFileSync(join(SRC_DIR, 'pages', 'OauthAuthorize.tsx'), 'utf8');
    expect(oauth).toContain('text-on-accent');
    expect(oauth).not.toMatch(/style=\{\{[^}]*color:/); // no inline colour override
  });

  it('ac-3: no regression — `text-on-accent` has exactly one consumer and the existing accent values are unchanged', () => {
    tagAc(AC(3));
    // Existing accent fills untouched (blue-400 dark / blue-600 light).
    expect(rgbVar(dark, 'accent')).toEqual([96, 165, 250]);
    expect(rgbVar(light, 'accent')).toEqual([37, 99, 235]);
    // Exactly one component consumes the utility.
    const files = readdirSync(SRC_DIR, { recursive: true }) as string[];
    const consumers = files
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
      .filter((f) => readFileSync(join(SRC_DIR, f), 'utf8').includes('text-on-accent'));
    expect(consumers).toEqual(['pages/OauthAuthorize.tsx']);
  });

  it('ac-4: --color-on-accent is slate-900 in .dark and white in .light', () => {
    tagAc(AC(4));
    expect(rgbVar(dark, 'on-accent')).toEqual([15, 23, 42]);
    expect(rgbVar(light, 'on-accent')).toEqual([255, 255, 255]);
  });

  it('ac-5: tailwind.config.js exposes `on-accent` so the `text-on-accent` utility resolves', () => {
    tagAc(AC(5));
    expect(tailwindConfig).toMatch(
      /'on-accent':\s*'rgb\(var\(--color-on-accent\) \/ <alpha-value>\)'/,
    );
  });
});
