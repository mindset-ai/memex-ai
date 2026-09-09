// spec-542 t-3 (ac-6, ac-12) — every footer-reachable grounding branch is
// reachable, and the two that are NOT reachable are unreachable on purpose.
//
// Sibling of scaffold-data.spec-542-grounding-claim.test.ts, which asserts the
// NEGATIVE (no response contradicts its subject). This file asserts the
// POSITIVE: each state reaches its own prose, from the real BASE_SCAFFOLD.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toNudge, type GroundingState } from './scaffold-model.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

const compose = (grounding?: GroundingState) =>
  toNudge({ dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'specify', grounding });

// The state-independent ask. Must survive on every read: it is the specify→build
// gate prompt, not a claim about this Spec.
const THE_ASK = /Call assess_spec again with `codeGrounding`/;

const CLAIM: Record<GroundingState, RegExp> = {
  not_grounded: /No code-grounding on this Spec/,
  grounded: /Code-grounding affirmed by agent/,
  grounded_stale: /Treat the grounding as out of date/,
};

describe('spec-542 — each grounding state reaches its own prose (ac-6)', () => {
  for (const state of Object.keys(CLAIM) as GroundingState[]) {
    it(`state=${state} emits its own claim and no other`, () => {
      tagAc(AC(6));

      const out = compose(state);
      expect(out, `${state} did not reach its own prose`).toMatch(CLAIM[state]);
      for (const other of Object.keys(CLAIM) as GroundingState[]) {
        if (other === state) continue;
        expect(out, `${state} also emitted the ${other} claim`).not.toMatch(CLAIM[other]);
      }
    });
  }

  it('the state-independent ask survives in every state, and with no state', () => {
    tagAc(AC(6));

    // Splitting the block must not cost the gate prompt. It is the half that
    // does NOT depend on the state, which is why it stays globally targeted.
    for (const state of Object.keys(CLAIM) as GroundingState[]) {
      expect(compose(state), `ask missing in state=${state}`).toMatch(THE_ASK);
    }
    expect(compose(undefined)).toMatch(THE_ASK);
  });

  it('the ask precedes the claim it introduces', () => {
    tagAc(AC(6));

    // The ask and the three claims share `order: 2`, so their relative order
    // rests on the stable sort ES2019 guarantees plus array position. This
    // PINS that rather than trusting it — a comment in scaffold-data.ts says
    // this test exists, so it has to.
    const out = compose('not_grounded');
    expect(out.search(THE_ASK)).toBeGreaterThan(-1);
    expect(out.search(THE_ASK)).toBeLessThan(out.search(CLAIM.not_grounded));
  });

  it('no single always-on block carries a grounding claim any more', () => {
    tagAc(AC(6));

    // The root cause, asserted against the DATA rather than the output: a
    // `target: {}` block carrying the claim is what made every Spec read the
    // same. If one reappears, this fails even if some other branch masks it.
    const alwaysOn = BASE_SCAFFOLD.baseGuidance.filter(
      (b) =>
        b.target.phase === undefined &&
        b.target.tool === undefined &&
        b.target.transition === undefined &&
        b.target.button === undefined &&
        b.target.grounding === undefined,
    );
    for (const b of alwaysOn) {
      for (const claim of Object.values(CLAIM)) {
        expect(b.text, `an always-on block asserts a grounding state: ${b.text.slice(0, 60)}`).not.toMatch(claim);
      }
    }
  });

  it('the not_applicable prose is unreachable from the footer, in every state', () => {
    tagAc(AC(6));

    // dec-3: it exists in the server-only markdown home and stays footer-
    // unreachable because the classification is transient to an assess_spec
    // call and never persisted. Pinned so a later reader who finds the orphaned
    // section cannot "fix" it into an unknowable claim.
    const NOT_APPLICABLE = /not code-touching; no grounding check applied/;
    for (const state of [...(Object.keys(CLAIM) as GroundingState[]), undefined]) {
      expect(compose(state), `not_applicable leaked in state=${state}`).not.toMatch(
        NOT_APPLICABLE,
      );
    }
  });
});

describe('spec-542 — a stale grounding is distinguishable from a fresh one (ac-12)', () => {
  it('stale and fresh compose different text', () => {
    tagAc(AC(12));

    // The branch dec-1 never considered. Before spec-542 a Spec grounded three
    // weeks ago whose decisions have since changed read identically to one
    // grounded five minutes ago — and both were told they were ungrounded.
    expect(compose('grounded_stale')).not.toBe(compose('grounded'));
  });

  it('the stale claim tells the reader to re-check, not that grounding is absent', () => {
    tagAc(AC(12));

    const out = compose('grounded_stale');
    expect(out).toMatch(/re-check the changed ones against current source/);
    // It is grounded — just out of date. Saying it is absent would be the
    // original defect wearing a different hat.
    expect(out).not.toMatch(CLAIM.not_grounded);
  });

  it('the stale prose is portable — no paths, no language, no tooling (std-22)', () => {
    tagAc(AC(12));

    const stale = BASE_SCAFFOLD.baseGuidance.find(
      (b) => b.target.grounding === 'grounded_stale',
    );
    expect(stale, 'no grounded_stale block registered').toBeDefined();
    // It ships to arbitrary codebases, so it may not name one.
    expect(stale!.text).not.toMatch(/\.ts\b|\.py\b|packages\/|src\/|vitest|pnpm|npm |git /i);
  });
});
