// spec-372 — design-token source-of-truth checks for the onboarding restyle. jsdom has no
// layout/cascade engine and never loads the real stylesheet, so the styling ACs are verified
// against index.css itself (the single source for these tokens, per dec-1/dec-2/dec-5/#3).
//   ac-1 / ac-13 — Inter UI + Geist Mono code; Hanken Grotesk @font-face + woff2 removed.
//   ac-2 / ac-11 / ac-12 — accent #0482DC (rgb 4 130 220) scoped to .font-onboarding only.
//   ac-3  — onboarding prompt containers wrap (no horizontal scroll).
//   ac-9 / ac-16 — the 34px/600/1.1/-0.015em onboarding heading scale.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

// Vitest runs with cwd = packages/ui, so the UI source tree is under ./src.
const SRC = resolve(process.cwd(), 'src');
const css = readFileSync(resolve(SRC, 'index.css'), 'utf8');

// The .font-onboarding rule block (its own braces), used to prove the accent override is
// SCOPED there and not in :root (ac-12 — no app-wide leak).
const fontOnboardingBlock = css.slice(
  css.indexOf('.font-onboarding {'),
  css.indexOf('}', css.indexOf('.font-onboarding {')) + 1,
);

describe('spec-372 onboarding design tokens (index.css source of truth)', () => {
  it('ac-1 / ac-13: Inter is self-hosted for UI, Geist Mono for code; Hanken is gone', () => {
    tagAc(AC(1));
    tagAc(AC(13));
    // Inter self-hosted + applied to the onboarding root.
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'Inter'[^}]*inter\.woff2/s);
    expect(fontOnboardingBlock).toMatch(/font-family:\s*'Inter'/);
    // Geist Mono retained for code/pre/kbd/samp.
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'Geist Mono'[^}]*geist-mono\.woff2/s);
    expect(css).toMatch(/\.font-onboarding (code|pre)[\s\S]*Geist Mono/);
    // No Hanken @font-face / woff2 left in the cascade or the build (a prose comment is fine).
    expect(css).not.toMatch(/font-family:\s*['"]?Hanken/i);
    expect(css).not.toMatch(/hanken[-a-z]*\.woff2/i);
    expect(existsSync(resolve(SRC, 'assets/fonts/hanken-grotesk.woff2'))).toBe(false);
  });

  it('ac-2 / ac-11: the onboarding accent is #0482DC (rgb 4 130 220) with white on-accent', () => {
    tagAc(AC(2));
    tagAc(AC(11));
    expect(fontOnboardingBlock).toMatch(/--ch-accent:\s*4 130 220/);
    expect(fontOnboardingBlock).toMatch(/--ch-on-accent:\s*255 255 255/);
    // hover companion is defined too (derives from #0482DC).
    expect(fontOnboardingBlock).toMatch(/--ch-accent-hover:\s*3 110 187/);
  });

  it('ac-12: the accent override is scoped to .font-onboarding, not the global :root token', () => {
    tagAc(AC(12));
    // The #0482DC channel value must NOT appear in a :root / .dark base block — only the
    // global blue tokens live there. (The override lives in the .font-onboarding block above.)
    const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('.font-onboarding'));
    expect(rootBlock).not.toMatch(/--ch-accent:\s*4 130 220/);
  });

  it('ac-3: onboarding prompt containers wrap instead of scrolling horizontally', () => {
    tagAc(AC(3));
    expect(css).toMatch(/\.font-onboarding pre\s*{[^}]*white-space:\s*pre-wrap/s);
    expect(css).toMatch(/\.font-onboarding pre\s*{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it('ac-9 / ac-16: the onboarding heading scale is 34px / 600 / 1.1 / -0.015em', () => {
    tagAc(AC(9));
    tagAc(AC(16));
    const heading = css.slice(
      css.indexOf('.onboarding-heading {'),
      css.indexOf('}', css.indexOf('.onboarding-heading {')) + 1,
    );
    expect(heading).toMatch(/font-size:\s*34px/);
    expect(heading).toMatch(/font-weight:\s*600/);
    expect(heading).toMatch(/line-height:\s*1\.1/);
    expect(heading).toMatch(/letter-spacing:\s*-0\.015em/);
    // theme-aware heading colour token (light ≈ #0F172A, v3 spec #0B1220 — ac-16 token equiv).
    expect(heading).toMatch(/color:\s*rgb\(var\(--ch-text-heading\)\)/);
  });
});
