// spec-510 t-2 (dec-1 — ac-8): the block-list projection, beside an UNCHANGED toNudge.
//
// WHY A SIBLING AND NOT A CHANGE. The seat cannot suppress an individual block
// today because `toNudge` hands it one joined string — by the time the seat sees
// it, the blocks are gone. dec-1 put suppression at the seat and kept the
// projector PURE, so the fix is ADDITIVE: a sibling that returns the blocks
// still addressable, with `toNudge` delegating to it and joining.
//
// WHY THAT MATTERS BEYOND TIDINESS. `packages/shared` exists to be free of
// request scope so it can serialize across the server↔React boundary [per
// std-15]. Suppression needs a session; a session is request scope. Pushing it
// into the projector would drag that scope into the shared package and break the
// React path. dec-1's phrasing: suppressing a block is *deciding not to send it*,
// not *composing text* — the decision belongs to the layer that sends.
//
// ⚠ WHY THERE IS NO "THE SIBLING AGREES WITH toNudge" TEST HERE. The obvious one
// — compare `toNudge(x)` against `toNudgeBlocks(x).map(text).join()` — CANNOT
// FAIL, because `toNudge` delegates to the sibling and joins. Divergence is
// impossible by construction, so such a test would assert nothing while looking
// thorough. (That is the same shape as the defect this Spec found in the
// footer-baseline guard, issue-6; not repeating it here.)
//
// What CAN fail, and is what t-2 actually promises, is that `toNudge`'s OUTPUT
// is unchanged by the refactor. So the surface is hashed against a value
// captured from the PRE-REFACTOR implementation. That is a real before/after,
// not a self-comparison.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toNudge, toNudgeBlocks } from './scaffold-model.js';
import type { GuidanceBlock, Phase } from './scaffold-model.js';

const AC_8 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-8';

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];
const GROUNDINGS = [undefined, 'not_grounded', 'grounded', 'grounded_stale'] as const;
/** Every tool the Scaffold knows about, plus the no-tool case. */
const TOOLS: Array<string | undefined> = [
  undefined,
  ...BASE_SCAFFOLD.tools.map((t) => t.name),
];

function orgBlock(over: Partial<GuidanceBlock> = {}): GuidanceBlock {
  return {
    kind: 'guidance_block',
    id: 'org-fixture-1',
    source: 'org',
    target: { phase: 'build' },
    text: 'ORG HOUSE STYLE',
    enabled: true,
    order: 5,
    rationale: 'fixture',
    ...over,
  };
}

/** Captured from the PRE-t-2 `toNudge` (commit 42f21be8) by running this exact
 *  composition against the implementation that built the string inline. Every
 *  (tool × phase × grounding) combination the Scaffold can produce. */
const PRE_REFACTOR = {
  combinations: 1520,
  totalChars: 14_241_767,
  sha256: '5df6bfb18300cf06d80b41ac53957d16e8438d664a4dcf945e999f9897356af4',
};

describe('spec-510 t-2 — toNudge output is unchanged by the refactor (ac-8)', () => {
  it('hashes identically to the pre-refactor implementation over the whole surface', () => {
    tagAc(AC_8);
    const parts: string[] = [];
    for (const tool of TOOLS) {
      for (const phase of PHASES) {
        for (const grounding of GROUNDINGS) {
          const input = { dataset: BASE_SCAFFOLD, tool, phase, grounding } as Parameters<
            typeof toNudge
          >[0];
          parts.push(`${tool ?? ''}|${phase}|${grounding ?? ''}|${toNudge(input)}`);
        }
      }
    }
    const joined = parts.join('\u0000');

    // Count and size first — they say WHICH WAY it moved when the hash fails.
    expect(parts.length, 'the surface itself changed size').toBe(PRE_REFACTOR.combinations);
    expect(joined.length, 'total emitted guidance changed length').toBe(PRE_REFACTOR.totalChars);
    expect(
      createHash('sha256').update(joined, 'utf8').digest('hex'),
      'toNudge emits different bytes than it did before t-2. The task is a PURE ' +
        'refactor — extract the block list, keep the joined output identical. If ' +
        'this moved, the extraction changed behaviour.',
    ).toBe(PRE_REFACTOR.sha256);
  });

  it('agrees once Org blocks are in play, including the base-then-org order', () => {
    tagAc(AC_8);
    const orgBlocks = [
      orgBlock({ id: 'org-a', order: 9, text: 'ORG A' }),
      orgBlock({ id: 'org-b', order: 1, text: 'ORG B' }),
      orgBlock({ id: 'org-off', enabled: false, text: 'ORG DISABLED' }),
    ];
    const input = { dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' as Phase, orgBlocks };

    const blocks = toNudgeBlocks(input);
    expect(blocks.map((b) => b.text).join('\n\n')).toBe(toNudge(input));

    // A disabled Org block contributes to neither.
    expect(blocks.some((b) => b.text === 'ORG DISABLED')).toBe(false);
    // Base first, Org second, each ordered by `order` — ORG B (1) before ORG A (9).
    const orgTexts = blocks.filter((b) => b.source === 'org').map((b) => b.text);
    expect(orgTexts).toEqual(['ORG B', 'ORG A']);
    const firstOrg = blocks.findIndex((b) => b.source === 'org');
    expect(blocks.slice(0, firstOrg).every((b) => b.source === 'base')).toBe(true);
  });
});

describe('spec-510 t-2 — the blocks come back ADDRESSABLE (dec-1, the point of the task)', () => {
  it('every returned block carries the id the claim key needs', () => {
    tagAc(AC_8);
    const blocks = toNudgeBlocks({ dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' });
    expect(blocks.length).toBeGreaterThan(0);
    // Without an id per block the seat can filter but cannot REMEMBER — which is
    // the whole reason t-11 minted ids before this task could be built.
    for (const b of blocks) {
      expect(typeof b.id, `block ${JSON.stringify(b.text.slice(0, 40))} has no id`).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
    }
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });
});

describe('spec-510 t-2 — toNudge stays STATELESS and pure (ac-8)', () => {
  it('takes exactly one argument — no session, seen-set or channel state', () => {
    tagAc(AC_8);
    // dec-1 keeps request scope out of `packages/shared` entirely. A second
    // parameter here would be the first crack in that: the React path would then
    // have to supply something it does not have.
    expect(toNudge.length).toBe(1);
    expect(toNudgeBlocks.length).toBe(1);
  });

  it('is referentially transparent — same input, same output, no accumulation', () => {
    tagAc(AC_8);
    const input = { dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' as Phase };
    const a = toNudge(input);
    const b = toNudge(input);
    const c = toNudge(input);
    // If suppression had leaked into the projector, the second call would differ
    // from the first. That is exactly the failure dec-1 designs against.
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(toNudgeBlocks(input).map((x) => x.id)).toEqual(toNudgeBlocks(input).map((x) => x.id));
  });

  it('does not mutate the dataset it was handed', () => {
    tagAc(AC_8);
    const before = BASE_SCAFFOLD.baseGuidance.map((b) => `${b.id}:${b.order}:${b.enabled}`);
    toNudgeBlocks({ dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' });
    toNudge({ dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' });
    expect(BASE_SCAFFOLD.baseGuidance.map((b) => `${b.id}:${b.order}:${b.enabled}`)).toEqual(before);
  });
});
