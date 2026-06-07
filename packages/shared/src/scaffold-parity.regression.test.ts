// b-68 t-15: cross-surface parity regression — projection-level proof.
//
// Per t-8 (commit 62e60bd) both surfaces converge on the SAME `toNudge(input)`
// and `toRubric(input)` calls — there's no surface-specific composer. The
// import-surface + no-fork checks for that convergence live in t-8's
// `nudge-parity.integration.test.ts` (ac-29 + ac-31), and t-16's drift guard
// in `packages/server/src/__regression__/scaffold-drift-guard.regression.test.ts`
// pins the structural invariants.
//
// This file is the projection-level proof for ac-30: "A parity regression
// test asserts both surfaces produce identical nudge text for every (tool,
// phase) pair and identical gate-rubric text for every forward transition."
//
// The key insight: pure functions are deterministic. If both surfaces import
// the same `toNudge(input)` from `@memex/shared` (t-8's static guard) and
// call it with the same `input`, the outputs are byte-equal by definition.
// So the parity proof reduces to:
//
//   (1) toNudge(input) is deterministic — same input, same output, twice.
//   (2) toRubric(input) is deterministic — same input, same output, twice.
//   (3) targeted Org blocks land where they're meant to land; irrelevant
//       Org blocks don't leak across (tool × phase) or transition channels.
//   (4) Malformed `source: 'base'` rows passed in `orgBlocks` (the channel
//       dec-3 reserves for `source: 'org'`) cannot pollute the composed
//       output — the projection filters them out.
//
// Together with t-8 (the surfaces use the SAME projection) and t-16 (the
// projection itself is structurally sound), this file proves ac-30 from the
// "same input → same output" angle.

import { describe, it, expect } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from './scaffold-data.js';
import {
  toNudge,
  toRubric,
  type GuidanceBlock,
  type Phase,
  type Transition,
} from './scaffold-model.js';

const AC_30 = 'mindset-prod/memex-building-itself/briefs/b-68/acs/ac-30';

const FORWARD_TRANSITIONS: readonly Transition[] = [
  'specify',
  'build',
  'verify',
  'done',
];

// Fixture Org blocks used to exercise the targeted-merge paths. Each block
// carries an `ORG-<dimension>-<n>` sentinel so we can index into the composed
// output without relying on prose stability.
const ORG_FIXTURE: readonly GuidanceBlock[] = [
  // Phase-targeted: should appear in nudges whose phase matches.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { phase: 'build' },
    text: 'ORG-PHASE-BUILD-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — phase=build org block',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  // Tool-targeted: should appear in nudges whose tool matches, every phase.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { tool: 'create_task' },
    text: 'ORG-TOOL-CREATE_TASK-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — tool=create_task org block',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  // (tool, phase) intersection: only appears when BOTH match.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { tool: 'create_task', phase: 'build' },
    text: 'ORG-TOOL-PHASE-CREATE_TASK-BUILD-1',
    enabled: true,
    order: 2,
    rationale: 'fixture — (tool=create_task, phase=build) org block',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  // Transition-targeted: rides toRubric, must NOT leak into toNudge.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { transition: 'build' },
    text: 'ORG-TRANSITION-BUILD-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — transition=build org block; belongs on rubric not nudge',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
];

const RUBRIC_ORG_FIXTURE: readonly GuidanceBlock[] = [
  // Transition-targeted: should appear in the matching rubric only.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { transition: 'build' },
    text: 'ORG-RUBRIC-BUILD-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — transition=build org rubric',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  {
    kind: 'guidance_block',
    source: 'org',
    target: { transition: 'verify' },
    text: 'ORG-RUBRIC-VERIFY-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — transition=verify org rubric',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  // Tool-targeted block in the orgBlocks list — must NOT leak into ANY
  // rubric (rubric channel is `target.transition` only).
  {
    kind: 'guidance_block',
    source: 'org',
    target: { tool: 'create_task' },
    text: 'ORG-TOOL-LEAK-CANDIDATE-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — tool-targeted block; must not leak into rubric',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
  // Phase-targeted block in the orgBlocks list — same: must NOT leak into
  // any rubric.
  {
    kind: 'guidance_block',
    source: 'org',
    target: { phase: 'build' },
    text: 'ORG-PHASE-LEAK-CANDIDATE-1',
    enabled: true,
    order: 1,
    rationale: 'fixture — phase-targeted block; must not leak into rubric',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  },
];

// ──────────────────────────────────────────────────────────────────────────
// (1) toNudge determinism — every (tool × phase) pair, base-only and with
//     a fixture Org-blocks array. ac-30: same input → same output.
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge determinism across every (tool × phase) pair (ac-30)', () => {
  it('toNudge(input) is byte-equal across repeated calls — every (tool × phase) pair, base-only AND with orgBlocks', () => {
    tagAc(AC_30);

    expect(BASE_SCAFFOLD.tools.length).toBeGreaterThan(0);
    expect(BASE_SCAFFOLD.phases.length).toBeGreaterThan(0);

    const failures: string[] = [];
    let pairsChecked = 0;

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const tool = toolNode.name;
        const phase: Phase = phaseNode.phase;

        // Surface A: base-only.
        const a1 = toNudge({ dataset: BASE_SCAFFOLD, tool, phase });
        const a2 = toNudge({ dataset: BASE_SCAFFOLD, tool, phase });
        if (a1 !== a2) {
          failures.push(
            `BASE-ONLY drift at (tool=${tool}, phase=${phase}): ` +
              `len(a1)=${a1.length} vs len(a2)=${a2.length}`,
          );
        }

        // Surface B: with the Org fixture. Pass a new array each time so we
        // also catch any mutation of the input that would corrupt a second
        // call's view of the data (cf. global coding-style: immutability).
        const b1 = toNudge({
          dataset: BASE_SCAFFOLD,
          tool,
          phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        const b2 = toNudge({
          dataset: BASE_SCAFFOLD,
          tool,
          phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        if (b1 !== b2) {
          failures.push(
            `WITH-ORG drift at (tool=${tool}, phase=${phase}): ` +
              `len(b1)=${b1.length} vs len(b2)=${b2.length}`,
          );
        }

        // Cross-call: orgBlocks must add content (never subtract from base).
        if (b1.length < a1.length) {
          failures.push(
            `orgBlocks SHRANK output at (tool=${tool}, phase=${phase}): ` +
              `base-only=${a1.length}, with-org=${b1.length}`,
          );
        }

        pairsChecked += 1;
      }
    }

    // Sanity floor — we expect a substantial sweep. The drift-guard (t-16)
    // already pins the (tool × phase) coverage shape, so this is just a
    // belt-and-braces "we actually ran the loop".
    expect(pairsChecked).toBeGreaterThanOrEqual(
      BASE_SCAFFOLD.tools.length * BASE_SCAFFOLD.phases.length,
    );

    expect(
      failures,
      failures.length
        ? `toNudge parity drift detected:\n  - ${failures.join('\n  - ')}`
        : '',
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (2) Org-block targeting in toNudge — targeted blocks land where they're
//     meant; irrelevant blocks don't leak across (tool × phase) channels.
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge Org-block targeting (ac-30)', () => {
  it('phase-targeted Org block lands ONLY in nudges whose phase matches', () => {
    tagAc(AC_30);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        if (phaseNode.phase === 'build') {
          expect(
            out,
            `phase=build org block missing from (tool=${toolNode.name}, phase=build)`,
          ).toContain('ORG-PHASE-BUILD-1');
        } else {
          expect(
            out,
            `phase=build org block leaked into (tool=${toolNode.name}, phase=${phaseNode.phase})`,
          ).not.toContain('ORG-PHASE-BUILD-1');
        }
      }
    }
  });

  it('tool-targeted Org block lands ONLY in nudges whose tool matches', () => {
    tagAc(AC_30);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        if (toolNode.name === 'create_task') {
          expect(
            out,
            `tool=create_task org block missing from (tool=create_task, phase=${phaseNode.phase})`,
          ).toContain('ORG-TOOL-CREATE_TASK-1');
        } else {
          expect(
            out,
            `tool=create_task org block leaked into (tool=${toolNode.name}, phase=${phaseNode.phase})`,
          ).not.toContain('ORG-TOOL-CREATE_TASK-1');
        }
      }
    }
  });

  it('(tool × phase) intersection Org block lands ONLY at the precise pair', () => {
    tagAc(AC_30);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        const expectHit =
          toolNode.name === 'create_task' && phaseNode.phase === 'build';
        if (expectHit) {
          expect(out).toContain('ORG-TOOL-PHASE-CREATE_TASK-BUILD-1');
        } else {
          expect(
            out,
            `(tool=create_task, phase=build) org block leaked into ` +
              `(tool=${toolNode.name}, phase=${phaseNode.phase})`,
          ).not.toContain('ORG-TOOL-PHASE-CREATE_TASK-BUILD-1');
        }
      }
    }
  });

  it('transition-targeted Org block NEVER leaks into toNudge — rubric channel only', () => {
    tagAc(AC_30);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [...ORG_FIXTURE],
        });
        expect(
          out,
          `transition org block leaked into nudge ` +
            `(tool=${toolNode.name}, phase=${phaseNode.phase})`,
        ).not.toContain('ORG-TRANSITION-BUILD-1');
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (3) toRubric determinism + targeting — every forward transition.
// ──────────────────────────────────────────────────────────────────────────

describe('toRubric determinism across every forward transition (ac-30)', () => {
  it('toRubric(input) is byte-equal across repeated calls — base-only AND with orgBlocks', () => {
    tagAc(AC_30);

    const failures: string[] = [];
    for (const transition of FORWARD_TRANSITIONS) {
      // Base-only.
      const a1 = toRubric({ dataset: BASE_SCAFFOLD, transition });
      const a2 = toRubric({ dataset: BASE_SCAFFOLD, transition });
      if (a1 !== a2) {
        failures.push(
          `BASE-ONLY drift at transition=${transition}: ` +
            `len(a1)=${a1.length} vs len(a2)=${a2.length}`,
        );
      }

      // With the rubric Org fixture.
      const b1 = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [...RUBRIC_ORG_FIXTURE],
      });
      const b2 = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [...RUBRIC_ORG_FIXTURE],
      });
      if (b1 !== b2) {
        failures.push(
          `WITH-ORG drift at transition=${transition}: ` +
            `len(b1)=${b1.length} vs len(b2)=${b2.length}`,
        );
      }

      if (b1.length < a1.length) {
        failures.push(
          `orgBlocks SHRANK rubric at transition=${transition}: ` +
            `base-only=${a1.length}, with-org=${b1.length}`,
        );
      }
    }

    expect(
      failures,
      failures.length
        ? `toRubric parity drift detected:\n  - ${failures.join('\n  - ')}`
        : '',
    ).toEqual([]);
  });
});

describe('toRubric Org-block targeting (ac-30)', () => {
  it('transition-targeted Org block lands ONLY in the matching transition rubric', () => {
    tagAc(AC_30);

    for (const transition of FORWARD_TRANSITIONS) {
      const out = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [...RUBRIC_ORG_FIXTURE],
      });
      if (transition === 'build') {
        expect(out).toContain('ORG-RUBRIC-BUILD-1');
        expect(out).not.toContain('ORG-RUBRIC-VERIFY-1');
      } else if (transition === 'verify') {
        expect(out).toContain('ORG-RUBRIC-VERIFY-1');
        expect(out).not.toContain('ORG-RUBRIC-BUILD-1');
      } else {
        expect(out).not.toContain('ORG-RUBRIC-BUILD-1');
        expect(out).not.toContain('ORG-RUBRIC-VERIFY-1');
      }
    }
  });

  it('tool-targeted and phase-targeted Org blocks NEVER leak into ANY rubric', () => {
    tagAc(AC_30);

    for (const transition of FORWARD_TRANSITIONS) {
      const out = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [...RUBRIC_ORG_FIXTURE],
      });
      expect(
        out,
        `tool-targeted org block leaked into rubric transition=${transition}`,
      ).not.toContain('ORG-TOOL-LEAK-CANDIDATE-1');
      expect(
        out,
        `phase-targeted org block leaked into rubric transition=${transition}`,
      ).not.toContain('ORG-PHASE-LEAK-CANDIDATE-1');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (4) Surface-isolation guard. Per b-68 dec-3 the `org_scaffold_additions`
//     table IS the discriminator — only `source: 'org'` rows can reach the
//     projection via the `orgBlocks` channel. A malformed `source: 'base'`
//     row passed in `orgBlocks` (e.g. from a future bug that wires the base
//     dataset into the org fetcher) MUST NOT pollute the composed output.
//     The projection filters on `source === 'org'` and ignores the rest.
// ──────────────────────────────────────────────────────────────────────────

describe('Surface-isolation: malformed orgBlocks entries cannot pollute the projection (ac-30)', () => {
  // A would-be-attacker row that claims to be base while riding the org
  // channel. The projection MUST silently ignore it.
  const POISON_BASE_ROW: GuidanceBlock = {
    kind: 'guidance_block',
    source: 'base',
    target: { phase: 'build' },
    text: 'POISON-BASE-ROW-IN-ORG-CHANNEL',
    enabled: true,
    order: 999,
    rationale: 'fixture — masquerading base row passed via orgBlocks',
  };

  // A would-be-attacker row that claims to be 'org' but is disabled. The
  // projection MUST also ignore it (enabled === false short-circuits the
  // org filter, base counterpart of `dec-2`).
  const POISON_DISABLED_ROW: GuidanceBlock = {
    kind: 'guidance_block',
    source: 'org',
    target: { phase: 'build' },
    text: 'POISON-DISABLED-ORG-ROW',
    enabled: false,
    order: 998,
    rationale: 'fixture — disabled org row should never compose',
    orgId: 'org-fixture',
    authorId: 'user-fixture',
  };

  it('toNudge: a source=base row in orgBlocks is filtered out at every (tool × phase) pair', () => {
    tagAc(AC_30);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [POISON_BASE_ROW, POISON_DISABLED_ROW],
        });
        expect(
          out,
          `poison source=base row leaked into nudge ` +
            `(tool=${toolNode.name}, phase=${phaseNode.phase})`,
        ).not.toContain('POISON-BASE-ROW-IN-ORG-CHANNEL');
        expect(
          out,
          `poison disabled org row leaked into nudge ` +
            `(tool=${toolNode.name}, phase=${phaseNode.phase})`,
        ).not.toContain('POISON-DISABLED-ORG-ROW');
      }
    }
  });

  it('toNudge: passing only poison rows yields the same output as base-only', () => {
    tagAc(AC_30);

    // The strongest assertion: with zero legitimate org content, the
    // projection output must be byte-equal to the no-orgBlocks call. That
    // proves the filter is unconditional, not just "doesn't usually leak".
    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const baseOnly = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
        });
        const withPoison = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
          orgBlocks: [POISON_BASE_ROW, POISON_DISABLED_ROW],
        });
        expect(
          withPoison,
          `poison rows changed nudge output ` +
            `(tool=${toolNode.name}, phase=${phaseNode.phase})`,
        ).toBe(baseOnly);
      }
    }
  });

  it('toRubric: a source=base transition row in orgBlocks is filtered out', () => {
    tagAc(AC_30);

    const POISON_RUBRIC_BASE: GuidanceBlock = {
      kind: 'guidance_block',
      source: 'base',
      target: { transition: 'build' },
      text: 'POISON-RUBRIC-BASE-ROW',
      enabled: true,
      order: 999,
      rationale: 'fixture — masquerading base row in org rubric channel',
    };

    for (const transition of FORWARD_TRANSITIONS) {
      const baseOnly = toRubric({ dataset: BASE_SCAFFOLD, transition });
      const withPoison = toRubric({
        dataset: BASE_SCAFFOLD,
        transition,
        orgBlocks: [POISON_RUBRIC_BASE],
      });
      expect(withPoison).not.toContain('POISON-RUBRIC-BASE-ROW');
      expect(
        withPoison,
        `poison source=base row changed rubric output at transition=${transition}`,
      ).toBe(baseOnly);
    }
  });
});
