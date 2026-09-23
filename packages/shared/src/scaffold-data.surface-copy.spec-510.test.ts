// spec-510 t-6 / dec-11 (ac-14): guidance may not name an affordance without
// saying which surface has it.
//
// WHY THIS EXISTS. t-5 added `channel` to `GuidanceTarget` so a block can be
// aimed at one agent surface. The t-6 sweep (s-12) then found that NO shipped
// guidance block needs it: the only surface-specific copy in the Scaffold lives
// in `prompt_block`s already scoped by `surface: 'react_only'`, in a Prompt
// Button (web by definition, std-23), and in two plain string constants that the
// dimension structurally cannot reach (dec-11).
//
// So this guard passes vacuously today, and that is exactly its value. The rule
// currently holds BY LUCK — nothing stops the next author writing "click the
// copy-prompt button" into a block that both an MCP coding agent and the in-app
// agent receive. From here, doing so fails the build and the author is made to
// say which surface they meant. t-5's dimension becomes load-bearing on the next
// edit rather than on a hypothetical one. This is the whole of what dec-11 (C)
// buys over doing nothing.
//
// THE MIRROR OF [std-34]. That rule stops a human surface instructing an
// MCP-only step. This stops the reverse: agent guidance describing a button,
// a panel or a page to a reader who has no screen.
//
// ⚠ WALKS THE BUILT OBJECT, NOT THE SOURCE FILE. A grep over `scaffold-data.ts`
// also hits `rationale` — developer-facing metadata that `toNudge` never emits
// (it emits `b.text` only). t-6 names one such false hit by line number. Reading
// the dataset means only real, agent-facing `text` is considered, whatever the
// file happens to look like.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import type { GuidanceBlock } from './scaffold-model.js';

const AC_14 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-14';

/**
 * Vocabulary that names an affordance rather than an idea. A reader without a
 * screen cannot act on any of it.
 *
 * Deliberately a small, blunt list. A cleverer regex would be harder to trust
 * and no more useful: the guard's job is to make the author STOP and declare a
 * channel, not to adjudicate prose. False positives are handled by the
 * exemption list below, in the open, one id at a time.
 */
const SURFACE_WORDS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ['button', /\bbuttons?\b/i],
  ['click', /\bclick(s|ed|ing)?\b/i],
  ['panel', /\bpanels?\b/i],
  ['page', /\bpages?\b/i],
  ['web UI', /\bweb UI\b/i],
];

/**
 * Blocks reviewed and deliberately left channel-neutral despite a match.
 *
 * EMPTY TODAY, and adding to it is the point rather than a defeat: an entry is
 * a visible, reviewed claim that the word is being used in a non-affordance
 * sense (say, "page through the results"). Widening the regex instead would
 * turn one reviewed exception into a silent blanket one — the kind of guard
 * that stays green forever and catches nothing.
 */
const REVIEWED_EXEMPTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // 'some-block-id': 'why this use of the word names no affordance',
]);

function surfaceHits(block: GuidanceBlock): string[] {
  return SURFACE_WORDS.filter(([, re]) => re.test(block.text)).map(([name]) => name);
}

describe('spec-510 t-6 / dec-11 — surface-specific guidance must declare its channel (ac-14)', () => {
  it('no base guidance block names an affordance without a channel target', () => {
    tagAc(AC_14);
    const offenders = BASE_SCAFFOLD.baseGuidance
      .filter((b) => b.target.channel === undefined)
      .filter((b) => !REVIEWED_EXEMPTIONS.has(b.id))
      .map((b) => ({ id: b.id, words: surfaceHits(b) }))
      .filter((o) => o.words.length > 0);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These guidance blocks name an affordance but reach BOTH agent surfaces:\n` +
          offenders.map((o) => `  - ${o.id}  (${o.words.join(', ')})`).join('\n') +
          `\n\nAn MCP coding agent has no screen: a button, panel or page it cannot ` +
          `reach is tokens spent describing a world it does not inhabit (the mirror ` +
          `of std-34's honest-CTA rule).\n\nFix ONE of two ways:\n` +
          `  1. Give the block a channel target — target: { channel: 'in_app_agent' } ` +
          `— and, if the coding agent also needs guidance here, author a SECOND block ` +
          `with its own id and target: { channel: 'mcp' }. Two blocks of data, never a ` +
          `branch in a projector (std-15).\n` +
          `  2. If the word names no affordance, add the id to REVIEWED_EXEMPTIONS in ` +
          `this file with the reason. Do not widen the regex.`,
    ).toEqual([]);
  });

  it('the guard is not vacuous: it sees a real violation and clears a declared one', () => {
    tagAc(AC_14);
    // The assertion above passes on an empty offender list, and would pass just
    // as happily if the matcher were broken or the field misspelt. So exercise
    // the predicate on both sides rather than trusting a green.
    const offending: GuidanceBlock = {
      kind: 'guidance_block',
      id: 'probe-offender',
      source: 'base',
      target: {},
      text: 'Use the copy-prompt button on the Spec page.',
      enabled: true,
      order: 99,
      rationale: 'probe',
    };
    expect(surfaceHits(offending).sort()).toEqual(['button', 'page']);
    expect(offending.target.channel).toBeUndefined();

    // …and the sanctioned fix silences it, so the message above names a real way out.
    const declared: GuidanceBlock = {
      ...offending,
      id: 'probe-declared',
      target: { channel: 'in_app_agent' },
    };
    expect(surfaceHits(declared).length).toBeGreaterThan(0);
    expect(declared.target.channel).toBe('in_app_agent');
  });

  it('rationale is out of scope — it is never emitted to any agent', () => {
    tagAc(AC_14);
    // The guard reads `text` only. `toNudge` emits `b.text`; `rationale` is
    // developer-facing metadata shown in the Scaffold UI. At least one shipped
    // node has surface words in its rationale, and flagging it would be noise —
    // so assert the exclusion holds rather than leaving it to the reader.
    const rationaleOnly = BASE_SCAFFOLD.baseGuidance.filter(
      (b) =>
        surfaceHits(b).length === 0 &&
        typeof b.rationale === 'string' &&
        SURFACE_WORDS.some(([, re]) => re.test(b.rationale as string)),
    );
    for (const b of rationaleOnly) {
      expect(surfaceHits(b)).toEqual([]);
    }
  });
});
