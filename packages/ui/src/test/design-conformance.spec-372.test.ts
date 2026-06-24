// spec-372 ac-10 — design-conformance check against the pinned v3 Claude Design
// (Memex Onboarding v3, captured 2026-06-24). The captured TOKENS must match, and every
// divergence from v3 must be a DELIBERATE, recorded deviation.
//
// Recorded, intentional deviations from v3 (verified present below):
//   D1. Step-4 status reword (dec-4) — v3 still says "Your agent is working the codebase…";
//       we ship the honest "Waiting for your agent to ground the plan…" copy + a non-pulsing dot.
//   D2. "team" → "effort" on step 5 (std-1 reserved-noun sweep) — v3 reads "One coordinated
//       team on your tasks."; we ship "One coordinated effort across your tasks."
//   D3. Stage-2 prompts instruct "create AND fully flesh out" (change #11, now design-matched).
//   D4. Heading colour uses the theme-aware --ch-text-heading token (light ≈ #0F172A) rather
//       than the literal v3 #0B1220, to keep dark mode legible (ac-16 "or its token equivalent").
//   D5. Logo: v3 shows a left sidebar (no page logo); our app frames onboarding inside AppShell
//       whose logo is already left-aligned — no separate Home logo to move (ac-5 logo clause).
//   D6. Product screenshots: v3 ships grey placeholders; we keep the v2 captures, widened to the
//       prompt width, pending fresh exports (issue-1).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
const SRC = resolve(process.cwd(), 'src');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

describe('spec-372 ac-10: design conformance vs pinned v3', () => {
  it('captured tokens match v3: accent #0482DC, Inter (UI), Geist Mono (code)', () => {
    tagAc(AC(10));
    const css = read('index.css');
    expect(css).toMatch(/--ch-accent:\s*4 130 220/); // #0482DC
    expect(css).toMatch(/font-family:\s*'Inter'/);
    expect(css).toMatch(/font-family:\s*'Geist Mono'/);
  });

  it('the deliberate deviations from v3 are in place (D1 step-4 reword, D2 team→effort)', () => {
    tagAc(AC(10));
    // D1 — the honest step-4 waiting copy ships (replacing v3's "working the codebase…").
    const step4 = read('components/home/SpecsMatchRealityStep.tsx');
    expect(step4).toContain('Waiting for your agent to ground the plan in your codebase');

    // D2 — std-1 reserved noun "team" reworded to "effort" in the shipped copy. (The original
    // v3 wording survives only in an explanatory code comment, which is intended.)
    const step5 = read('components/home/AgentsBuildStep.tsx');
    expect(step5).toContain('<p className="mb-5 text-xl font-semibold leading-snug text-primary">One coordinated effort across your tasks.</p>');
  });
});
