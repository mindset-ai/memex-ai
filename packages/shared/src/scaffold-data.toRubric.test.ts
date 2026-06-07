// b-68 t-5: toRubric edge-case coverage against the REAL `BASE_SCAFFOLD`.
//
// Mirrors the shape of `scaffold-data.toNudge.test.ts` (t-4) — synthetic
// projection tests live in `scaffold-model.test.ts`; this file exercises the
// composition against the actual base dataset so regressions from base-data
// edits or projection drift surface against real prose.
//
// Per b-68 dec-3, the composed output reads as ONE coherent set of guidance,
// not a layered one. No "base wins" / "never override" / "authoritative" /
// "precedence" disclaimers must appear in the rendered string at any forward
// transition.

import { describe, it, expect } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toRubric, type GuidanceBlock, type Transition } from './scaffold-model.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/briefs/b-68/acs/ac-${n}`;

const FORWARD_TRANSITIONS: readonly Transition[] = [
  'specify',
  'build',
  'verify',
  'done',
];

// Negative matchers — anything that smells like a "base wins" / "never
// override" disclaimer must not appear in toRubric output (b-68 dec-3 /
// ac-12). Mirrors the same patterns the toNudge sibling test uses.
const PRECEDENCE_PATTERNS = [
  /never override/,
  /base wins/,
  /authoritative/,
  /precedence/,
  /refines but never/,
  /cannot contradict/,
];

// ──────────────────────────────────────────────────────────────────────────
// ac-12: no precedence preamble in toRubric against the REAL dataset.
// Exercises every forward transition with the base scaffold alone AND with a
// representative Org-block layered on top — the disclaimer-free contract
// must hold in both shapes.
// ──────────────────────────────────────────────────────────────────────────

describe('toRubric against BASE_SCAFFOLD — no precedence preamble (ac-12)', () => {
  for (const transition of FORWARD_TRANSITIONS) {
    it(`(transition=${transition}, base only) carries no "base wins" / "never override" disclaimer`, () => {
      tagAc(AC(12));

      const out = toRubric({ dataset: BASE_SCAFFOLD, transition });
      const lower = out.toLowerCase();
      for (const pattern of PRECEDENCE_PATTERNS) {
        expect(lower, `precedence pattern ${pattern} matched in (${transition}, base only)`).not.toMatch(
          pattern,
        );
      }
    });

    it(`(transition=${transition}, base + Org block) carries no "base wins" / "never override" disclaimer`, () => {
      tagAc(AC(12));

      // Synthetic Org block targeted at this transition. The text is plain
      // prose with no hedging — the precedence patterns must come from a
      // composition-layer disclaimer if anywhere, never from the data itself,
      // so this is a fair negative-control assertion.
      const orgBlock: GuidanceBlock = {
        kind: 'guidance_block',
        source: 'org',
        target: { transition },
        text: `Org-specific rubric guidance for the ${transition} gate. No hedging.`,
        enabled: true,
        order: 0,
        orgId: 'org-test',
        authorId: 'user-test',
        rationale: 'test-fixture: synthetic Org rubric block for ac-12 negative-control assertion.',
      };
      const out = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [orgBlock],
      });
      const lower = out.toLowerCase();
      for (const pattern of PRECEDENCE_PATTERNS) {
        expect(lower, `precedence pattern ${pattern} matched in (${transition}, base + org)`).not.toMatch(
          pattern,
        );
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ac-32 reinforcement: every forward transition has non-empty base rubric
// prose retrievable via toRubric. (scaffold-data.test.ts already asserts
// each TransitionRubric has non-empty text; this asserts the projection
// surfaces it.)
// ──────────────────────────────────────────────────────────────────────────

describe('toRubric against BASE_SCAFFOLD — base prose is surfaced for every forward transition', () => {
  for (const transition of FORWARD_TRANSITIONS) {
    it(`(transition=${transition}) returns non-empty rubric prose from the base dataset`, () => {
      const out = toRubric({ dataset: BASE_SCAFFOLD, transition });
      expect(out.trim().length).toBeGreaterThan(0);
    });
  }
});
