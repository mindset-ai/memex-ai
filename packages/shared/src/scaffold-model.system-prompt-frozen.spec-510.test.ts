// spec-510 t-8 (ac-15) — the system-prompt channel is FROZEN for the duration of
// this Spec.
//
// WHY THIS GUARD EXISTS, AND WHY IT IS NOT TIDINESS. spec-510 rewrites the FOOTER
// channel (`toNudge` → composeGuidanceEnvelope) twice over: suppression removes
// static blocks after first sight, and channel targeting changes which blocks
// match at all. The SYSTEM-PROMPT channel — `toPhaseGuidance`, consumed at
// `packages/server/src/agent/system-prompt.ts:269` — is a DIFFERENT channel,
// emitted once per conversation, with nothing repeated to suppress. It must not
// move.
//
// dec-5 was authored on exactly this confusion (two similarly-named projections
// read as one) and was DISSOLVED once the source was read. This test is what
// stops that recurring: `toPhaseGuidance` and `toNudge` are neighbours in
// scaffold-model.ts, and the Spec's original `toNudge` line anchor had already
// drifted onto `toPhaseGuidance` by the time it was re-grounded (s-4, Bucket 1).
// No line numbers are cited here on purpose — resolve both by SYMBOL. Citing a
// line in an anti-drift guard is how the guard itself goes stale; this file's
// own anchors were wrong within one task of being written.
//
// THE ORG-ISOLATION HALF (b-68 ac-31). The React path deliberately excludes
// cross-phase globals AND Org additions. Widening that block set — even as a
// well-meaning side effect of "making both surfaces consistent" — would breach a
// tenancy guarantee. The guarantee here is STRUCTURAL rather than behavioural:
// `toPhaseGuidance(dataset, phase)` has no `orgBlocks` parameter, so an Org block
// has no way in. Asserting the arity is therefore a stronger check than passing
// Org blocks and looking for their absence — you cannot pass them at all.
//
// IF THIS TEST REDS: do not update the hashes to make it green. A changed hash
// means the React agent's system prompt changed, which ac-15 says must not happen
// while spec-510 is in flight. Either the change belongs in the footer channel
// (fix the code) or the freeze is being lifted deliberately (record that on the
// Spec first, then move the hash).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toPhaseGuidance } from './scaffold-model.js';
import type { Phase } from './scaffold-model.js';

const AC_15 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-15';

/** Captured 2026-09-22 from `origin/develop` @ c3affa4e, before any spec-510
 *  footer work reached this channel. Length travels with the hash so a failure
 *  says WHICH WAY the prompt moved, not merely that it did. */
const FROZEN: Record<Phase, { sha256: string; length: number }> = {
  draft: { sha256: '1e531c2a0293ad4949b1ce0cdda76324d4a6135fb6024c88136033c069774b36', length: 8824 },
  specify: { sha256: 'b1cdfca13a7172f8b4c2230d8a46317b4383c512a11e18b0d29db955838f2b31', length: 10583 },
  build: { sha256: 'df26c234cdfe0b12b3ae9b314005fe03cc37e211216a15575887adb1643bc055', length: 8273 },
  verify: { sha256: 'd60e5ce2fe5300b23e3ebc0f20c6b3ecbd015651fd0fc48632ffbe0050dc713f', length: 4415 },
  done: { sha256: '8dec8548b03d8b8a41b6b89a99af7f58a06f86aa30dd17217a3bb439b9ee41a3', length: 1480 },
};

const PHASES = Object.keys(FROZEN) as Phase[];

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('spec-510 t-8 — toPhaseGuidance is byte-identical (ac-15)', () => {
  it.each(PHASES)('%s: the system prompt has not moved', (phase) => {
    tagAc(AC_15);
    const out = toPhaseGuidance(BASE_SCAFFOLD, phase);
    const frozen = FROZEN[phase];

    // Length first: it is the readable half of the failure.
    expect(
      out.length,
      `toPhaseGuidance('${phase}') changed size: ${frozen.length} → ${out.length} chars. ` +
        `ac-15 freezes the React system prompt while spec-510 reworks the FOOTER. ` +
        `If a footer change reached this projection, that is the defect — not this test.`,
    ).toBe(frozen.length);

    expect(
      sha(out),
      `toPhaseGuidance('${phase}') changed content at the same length. ` +
        `Same size, different bytes — a substitution, which is exactly what a ` +
        `size-only guard would have missed.`,
    ).toBe(frozen.sha256);
  });

  it('covers every phase — a new phase cannot slip past the freeze', () => {
    tagAc(AC_15);
    // BASE_SCAFFOLD's phases are the population; if one is added, FROZEN must
    // grow with it rather than the new phase going unguarded.
    const declared = BASE_SCAFFOLD.phases.map((p) => p.phase).sort();
    expect(PHASES.slice().sort()).toEqual(declared);
  });
});

describe('spec-510 t-8 — no Org block can reach the React system prompt (ac-15, b-68 ac-31)', () => {
  it('toPhaseGuidance takes (dataset, phase) and nothing else', () => {
    tagAc(AC_15);
    // The org-isolation guarantee is structural, not behavioural: there is no
    // parameter through which an Org addition could arrive. Adding one — e.g.
    // to "make both surfaces consistent" — breaks this immediately, which is the
    // point. `toNudge`, the FOOTER projection, does take orgBlocks; that
    // asymmetry is deliberate and is the whole of b-68 ac-31.
    expect(
      toPhaseGuidance.length,
      'toPhaseGuidance gained a parameter. If it is orgBlocks, the b-68 ac-31 ' +
        'org-isolation guarantee is breached: Org additions would reach the React ' +
        'system prompt. Nothing in spec-510 requires that.',
    ).toBe(2);
  });
});
