// spec-542 t-1 (ac-9, ac-10, ac-11) — no composed nudge asserts something untrue
// about the Spec it describes.
//
// THIS FILE IS RED BY DESIGN until t-2/t-3 land. It is written first, per std-52:
// a defect's cause is claimed only after a command goes red on it. The red output
// is recorded on t-1.
//
// The defect: `BASE_CODE_GROUNDING` (scaffold-data.ts) fuses the grounding *ask*
// and the ⚠ *warning* into one flat string, and BASE_GUIDANCE registers it with
// `target: {}` — matching every tool, every phase, every Spec. So a grounded Spec
// and an ungrounded one emit byte-identical text, and both say "No code-grounding
// on this Spec".
//
// WHY THIS SHAPE (dec-2): the sibling guard for this defect family
// (`no-unheld-bound-claims.spec-538.regression.test.ts`) scans source COMMENTS in
// `packages/server/src`. It cannot reach this defect on two independent counts —
// wrong corpus (the prose lives in `packages/shared`) and wrong artifact class (a
// runtime response string, not a comment). So this guard asserts on the COMPOSED
// OUTPUT instead, which catches a re-flattening no matter which file causes it.
//
// WHY IT LIVES IN `packages/shared` (ac-10): `toNudge` is a pure projection here,
// and this package's vitest has no globalSetup provisioning a database — so the
// guard runs in a genuinely cheap gate. The server suite is not offline.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toNudge, type Phase } from './scaffold-model.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

// The four states dec-3 settled on. `not_applicable` is deliberately absent: the
// classification is transient to an `assess_spec` call and is not persisted, so
// the footer cannot know it (dec-3). `no_context` is a tool that resolves no Spec.
type GroundingState = 'not_grounded' | 'grounded' | 'grounded_stale' | 'no_context';

const ALL_STATES: readonly GroundingState[] = [
  'not_grounded',
  'grounded',
  'grounded_stale',
  'no_context',
];

// The claim that must never appear about a Spec it is not true of.
const NEGATIVE_CLAIM = /No code-grounding on this Spec/i;
// The tell that the condition is written INTO the prose rather than evaluated.
const PROSE_CONDITIONAL = /If unverified:/i;
// The affirmative branch — prose that already exists in the server-only home
// (`agent/phases/_base/code-grounding.md`, `## nudge:verified`) and is currently
// unreachable from the footer.
const AFFIRMATIVE_CLAIM = /Code-grounding affirmed/i;

/**
 * THE SEAM. Composes the nudge as it will be composed for `state`.
 *
 * Today `toNudge` has no grounding dimension at all — `matchesNudgeTarget`
 * discriminates only on transition/button/phase/tool, and `ToNudgeInput` never
 * receives the Spec's state. So this helper currently ignores `state`, which is
 * precisely why the assertions below go red: four different states compose ONE
 * identical string.
 *
 * t-2 adds `grounding` to the target model and `ToNudgeInput`; at that point this
 * helper passes the state through and nothing else in this file changes. Keeping
 * the seam here (rather than in each test) means the fix touches one line.
 */
function composeFor(state: GroundingState, tool: string, phase: Phase): string {
  return toNudge({
    dataset: BASE_SCAFFOLD,
    tool: state === 'no_context' ? undefined : tool,
    phase: state === 'no_context' ? undefined : phase,
    // t-2: pass `grounding: state` here once the dimension exists.
  });
}

describe('spec-542 — no composed nudge contradicts its subject', () => {
  // ── The self-check (ac-11) ──────────────────────────────────────────────
  // A guard that quietly composes an empty string would satisfy every negative
  // assertion below while checking nothing at all. That failure mode is silent
  // and looks exactly like success, so it is asserted before anything else.
  it('the guard composes a REAL nudge, not an empty string', () => {
    tagAc(AC(11));

    const out = composeFor('grounded', 'get_doc', 'specify');
    expect(out.length).toBeGreaterThan(500);
    // A different global block, to prove the whole projection ran rather than
    // one lucky substring surviving.
    expect(out).toMatch(/Reference elements by their handle/);
  });

  // ── Placement (ac-10) ───────────────────────────────────────────────────
  // The guard asserts its OWN location, so a later move into the server suite
  // fails here rather than quietly costing every run a database. `toNudge` is a
  // pure projection in this package and this package's vitest provisions no DB;
  // the server suite's globalSetup does. Placement is part of the choice.
  it('lives in @memex/shared, the package whose suite needs no database', () => {
    tagAc(AC(10));

    expect(import.meta.url).toMatch(/\/packages\/shared\//);
    // And it composes with nothing but the dataset — no server import, no client,
    // no fixture. If this file ever needs one, it is in the wrong package.
    expect(typeof toNudge).toBe('function');
  });

  // ── Negative-first assertions (ac-9) ────────────────────────────────────
  // The defect was never a MISSING string; it was a PRESENT and wrong one. So
  // the load-bearing assertions are the negatives.

  it('a GROUNDED Spec is never told it has no code-grounding', () => {
    tagAc(AC(9));

    const out = composeFor('grounded', 'get_doc', 'specify');
    expect(out, 'a grounded Spec is being told the opposite').not.toMatch(NEGATIVE_CLAIM);
  });

  it('a STALE-grounded Spec is not presented as freshly grounded', () => {
    tagAc(AC(9));

    const out = composeFor('grounded_stale', 'get_doc', 'specify');
    // It must not claim the plain affirmative, and must not claim the flat
    // negative either — a stale grounding is neither.
    expect(out, 'a stale grounding is being reported as fresh').not.toMatch(AFFIRMATIVE_CLAIM);
    expect(out, 'a stale grounding is being reported as absent').not.toMatch(NEGATIVE_CLAIM);
  });

  it('a read with NO Spec context makes no grounding claim at all', () => {
    tagAc(AC(9));

    // ac-7's case, and the one today's code gets most clearly wrong: "nothing
    // known" is rendered as "known to be ungrounded".
    const out = composeFor('no_context', 'list_memexes', 'specify');
    expect(out, 'a read that knows nothing is asserting a grounding state').not.toMatch(
      NEGATIVE_CLAIM,
    );
  });

  it('an UNGROUNDED Spec is not told it is grounded', () => {
    tagAc(AC(9));

    const out = composeFor('not_grounded', 'get_doc', 'specify');
    expect(out).not.toMatch(AFFIRMATIVE_CLAIM);
  });

  // ── The structural assertion: the states must actually differ ────────────
  // This is the defect stated at its root. States producing one identical string
  // is the whole bug, and it is the assertion that stays meaningful even if the
  // exact wording of every branch changes later.
  //
  // ONLY the three same-context states are compared. An earlier version of this
  // test swept all four including `no_context` and PASSED against the broken
  // code — because `no_context` also drops `tool`/`phase`, so its output differs
  // for a reason that has nothing to do with grounding. A green that cannot fail
  // on this defect proves nothing (std-52), so the varying dimension is isolated:
  // same tool, same phase, grounding state the only difference.
  it('the three same-context grounding states do not compose the same text', () => {
    tagAc(AC(9));

    const SAME_CONTEXT: readonly GroundingState[] = [
      'not_grounded',
      'grounded',
      'grounded_stale',
    ];
    const composed = SAME_CONTEXT.map((s) => composeFor(s, 'get_doc', 'specify'));
    const distinct = new Set(composed);
    expect(
      distinct.size,
      `all ${SAME_CONTEXT.length} grounding states composed byte-identical output at ` +
        '(tool=get_doc, phase=specify) — the grounding claim is unconditional',
    ).toBe(SAME_CONTEXT.length);
  });

  // ── The prose-conditional tell ──────────────────────────────────────────
  // "If unverified:" is a condition written into the sentence instead of being
  // evaluated by code. Its presence anywhere in a composed nudge means the
  // reader is being asked to evaluate a branch the system should have resolved.
  it('no composed nudge asks the READER to evaluate the condition', () => {
    tagAc(AC(9));

    for (const state of ALL_STATES) {
      const out = composeFor(state, 'get_doc', 'specify');
      expect(out, `prose conditional survives in state=${state}`).not.toMatch(PROSE_CONDITIONAL);
    }
  });
});
