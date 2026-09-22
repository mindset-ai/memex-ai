// spec-510 t-13 — a block that can be SUPPRESSED must be RECOVERABLE.
// PR #740 round-9, H-18.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS EXISTS FOR, and it is worth stating because it happened
// INSIDE the fix for the same class. dec-12 replaced a pointer that named a
// topic containing none of what it stood in for. The replacement projection then
// enumerated (tool x grounding) and unioned — while `matchesNudgeTarget` selects
// on FOUR dimensions, the fourth being `channel`, added by this Spec's own t-5.
//
// The seat passes `ctx.channel`, so a channel-targeted block is suppressible.
// The projection passed `channel: undefined`, and the matcher rejects a
// channel-targeted block when the context's is unset. Suppressible, never
// recoverable — H-1 rebuilt inside the fix for H-1.
//
// AND THE FIRST GUARD COULD NOT SEE IT. `guidance-recovery.spec-510.test.ts`
// builds its expected set with the same two axes. Both sides derived, both from
// the same blind spot — s-14's "generate, don't curate" caveat landing on itself:
// a completeness check answerable to the enumeration instead of to the source.
//
// So this file does NOT enumerate dimensions either. It asserts the PROPERTY —
// reachable implies recoverable — over blocks constructed to exercise each kind
// of target, and fails loudly on the one dimension the projection cannot serve.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toGuidanceRecovery, toNudgeBlocks } from './scaffold-model.js';
import type { GuidanceBlock, Phase } from './scaffold-model.js';

const AC_25 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-25';
const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];

function block(over: Partial<GuidanceBlock>): GuidanceBlock {
  return {
    kind: 'guidance_block',
    id: 'completeness-probe',
    source: 'base',
    target: {},
    text: 'COMPLETENESS PROBE BODY',
    enabled: true,
    order: 99,
    rationale: 'probe',
    ...over,
  };
}

const withProbe = (b: GuidanceBlock) => ({
  ...BASE_SCAFFOLD,
  baseGuidance: [...BASE_SCAFFOLD.baseGuidance, b],
});

describe('spec-510 — no base block carries a channel target (the loud hole)', () => {
  it('fails the build on the first channel-targeted base block', () => {
    tagAc(AC_25);
    // ⚠ THIS IS NOT A STYLE RULE. A recovery document scoped only by phase
    // cannot honour `channel`: including a channel-targeted block hands an MCP
    // agent prose written because the web UI has an affordance it does not —
    // the thing dec-4 exists to prevent — and excluding it silently is H-18.
    // Neither is acceptable, so while the dimension has no users this is where
    // the next author is stopped.
    const offenders = BASE_SCAFFOLD.baseGuidance
      .filter((b) => b.target.channel !== undefined)
      .map((b) => `${b.id} (channel: ${b.target.channel})`);

    expect(
      offenders,
      'A base guidance block now carries a `channel` target:\n  ' +
        offenders.join('\n  ') +
        '\n\nThe recovery topic is scoped by PHASE ALONE, and `reachableInPhase` ' +
        'does not model `channel` — so that block IS included in every ' +
        "channel's recovery body. The failure is a LEAK: an in-app agent " +
        'fetching the topic reads prose written because an MCP agent lacks an ' +
        'affordance, or the reverse. That is what dec-4 exists to prevent.\n\n' +
        '(Before PR #740 round-9 the failure was the opposite — the block was ' +
        'suppressible and ABSENT from recovery. Removing the axis enumeration ' +
        'flipped the direction: over-inclusion rather than silence. Both are ' +
        'wrong; this one is at least visible to whoever reads the topic.)\n\n' +
        'Serving it means scoping the recovery topic by (phase, channel) and ' +
        'threading ctx.channel from the get_information handler, which today ' +
        'takes no ctx. Do that — do not delete this guard.',
    ).toEqual([]);
  });
});

describe('spec-510 — reachable implies recoverable, without enumerating (ac-25)', () => {
  it('a block narrowed by TOOL is still recovered', () => {
    tagAc(AC_25);
    // `tool` narrows WHEN within a phase, so it belongs in the phase's recovery
    // document. The old enumeration happened to cover this; the filter covers it
    // by construction.
    const probe = block({ target: { phase: 'build', tool: 'create_task' } });
    expect(toGuidanceRecovery(withProbe(probe), 'build')).toContain(probe.text);
  });

  it('a block narrowed by GROUNDING is still recovered', () => {
    tagAc(AC_25);
    const probe = block({ target: { phase: 'build', grounding: 'grounded_stale' } });
    expect(toGuidanceRecovery(withProbe(probe), 'build')).toContain(probe.text);
  });

  it('a block excluded from nudges STRUCTURALLY is not recovered either', () => {
    tagAc(AC_25);
    // `transition` and `button` are the matcher's two UNCONDITIONAL rejections —
    // such a block never reaches an agent as a nudge, so recovering it would put
    // prose in the document that was never taken away.
    for (const target of [
      { phase: 'build' as Phase, transition: 'verify' as const },
      { phase: 'build' as Phase, button: 'some-button' },
    ]) {
      const probe = block({ target });
      expect(toGuidanceRecovery(withProbe(probe), 'build')).not.toContain(probe.text);
      // …and confirm the premise rather than assuming it: the matcher really
      // does refuse it, so "not recovered" matches "never shown".
      expect(
        toNudgeBlocks({
          dataset: withProbe(probe),
          tool: 'create_task',
          phase: 'build',
          grounding: 'grounded',
        }).some((b) => b.text === probe.text),
      ).toBe(false);
    }
  });

  it('the WHOLE shipped block set is recoverable in every phase it can appear in', () => {
    tagAc(AC_25);
    // The population guard: no synthetic probe, just every real block. If a
    // future dimension makes a block suppressible-but-unrecoverable, this reds
    // as soon as a block uses it — which is what the channel case showed a
    // per-axis guard cannot do.
    for (const phase of PHASES) {
      const body = toGuidanceRecovery(BASE_SCAFFOLD, phase);
      const shown = toNudgeBlocks({
        dataset: BASE_SCAFFOLD,
        tool: 'get_doc',
        phase,
        grounding: 'grounded',
      });
      const missing = shown.filter((b) => !body.includes(b.text)).map((b) => b.id);
      expect(missing, `unrecoverable in '${phase}': ${missing.join(', ')}`).toEqual([]);
    }
  });
});
