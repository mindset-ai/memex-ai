// spec-542 t-2 (ac-5, ac-7) — the `grounding` selection dimension on
// GuidanceTarget, exercised against SYNTHETIC datasets.
//
// Deliberately synthetic, matching the split scaffold-model.test.ts already
// draws: this file tests the MECHANISM (does the projection discriminate on
// grounding?), while scaffold-data.spec-542-grounding-claim.test.ts tests the
// real BASE_SCAFFOLD data (does the shipped footer still lie?). t-2 delivers the
// mechanism; t-3 rewires the data. Mixing the two would leave this file red for
// a reason it does not own.
//
// The whole design rests on one line in `matchesNudgeTarget` written in the same
// style as its `phase` clause, which yields BOTH required behaviours at once:
//   - target.grounding undefined            → matches every state (back-compat)
//   - target.grounding set, context unknown → does NOT match (ac-7)

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  toNudge,
  type GroundingState,
  type GuidanceBlock,
  type ScaffoldDataset,
} from './scaffold-model.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

const ALL_STATES: readonly GroundingState[] = ['not_grounded', 'grounded', 'grounded_stale'];

function block(text: string, target: GuidanceBlock['target'], order = 0): GuidanceBlock {
  return { kind: 'guidance_block', source: 'base', target, text, enabled: true, order };
}

/** A dataset carrying only `baseGuidance` — the rest is empty, since toNudge
 *  reads nothing else. */
function datasetOf(...blocks: GuidanceBlock[]): ScaffoldDataset {
  return {
    phases: [],
    promptBlocks: [],
    tools: [],
    transitions: [],
    baseGuidance: blocks,
    promptButtons: [],
  } as unknown as ScaffoldDataset;
}

describe('spec-542 — grounding as a nudge-target dimension (ac-5)', () => {
  it('a grounding-targeted block fires ONLY in its own state', () => {
    tagAc(AC(5));

    const dataset = datasetOf(
      block('YOU ARE GROUNDED', { grounding: 'grounded' }),
      block('YOU ARE NOT GROUNDED', { grounding: 'not_grounded' }),
      block('YOUR GROUNDING IS STALE', { grounding: 'grounded_stale' }),
    );

    expect(toNudge({ dataset, grounding: 'grounded' })).toBe('YOU ARE GROUNDED');
    expect(toNudge({ dataset, grounding: 'not_grounded' })).toBe('YOU ARE NOT GROUNDED');
    expect(toNudge({ dataset, grounding: 'grounded_stale' })).toBe('YOUR GROUNDING IS STALE');
  });

  it('a block with NO grounding on its target still matches every state', () => {
    tagAc(AC(5));

    // The back-compatibility guarantee. The three other global blocks in the
    // real scaffold (about-spec, mutation-protocol, standards-protocol) rely on
    // this: adding a dimension must not narrow blocks that never opted into it.
    const dataset = datasetOf(block('ALWAYS', {}));

    for (const grounding of ALL_STATES) {
      expect(toNudge({ dataset, grounding }), `state=${grounding}`).toBe('ALWAYS');
    }
    // …including when the state is unknown.
    expect(toNudge({ dataset })).toBe('ALWAYS');
  });

  it('grounding composes with the existing dimensions rather than replacing them', () => {
    tagAc(AC(5));

    // A block carrying BOTH must satisfy both. This is the assertion that fails
    // if the new clause is written as an early `return true` instead of an early
    // `return false` — a shape that would let a grounding match override a
    // phase mismatch.
    const dataset = datasetOf(
      block('BUILD AND GROUNDED', { phase: 'build', grounding: 'grounded' }),
    );

    expect(toNudge({ dataset, phase: 'build', grounding: 'grounded' })).toBe(
      'BUILD AND GROUNDED',
    );
    expect(toNudge({ dataset, phase: 'specify', grounding: 'grounded' })).toBe('');
    expect(toNudge({ dataset, phase: 'build', grounding: 'not_grounded' })).toBe('');
  });
});

describe('spec-542 — an unknown grounding state claims nothing (ac-7)', () => {
  it('no grounding-targeted block fires when the state is absent', () => {
    tagAc(AC(7));

    // The bug in miniature. "Nothing known" must not resolve to "known to be
    // ungrounded" — so a call with no grounding state selects NONE of the three,
    // not the not_grounded one. Mirrors how `phase` already behaves per b-68 D-7.
    const dataset = datasetOf(
      block('YOU ARE GROUNDED', { grounding: 'grounded' }),
      block('YOU ARE NOT GROUNDED', { grounding: 'not_grounded' }),
      block('YOUR GROUNDING IS STALE', { grounding: 'grounded_stale' }),
    );

    expect(toNudge({ dataset })).toBe('');
    expect(toNudge({ dataset, grounding: undefined })).toBe('');
  });

  it('an unknown state still receives grounding-agnostic guidance', () => {
    tagAc(AC(7));

    // The fallthrough must drop the grounding CLAIM without dropping everything
    // else — a read that knows nothing about grounding is still a read.
    const dataset = datasetOf(
      block('GENERAL GUIDANCE', {}, 0),
      block('YOU ARE NOT GROUNDED', { grounding: 'not_grounded' }, 1),
    );

    expect(toNudge({ dataset })).toBe('GENERAL GUIDANCE');
  });
});
