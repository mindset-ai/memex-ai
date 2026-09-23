// spec-510 t-5 (dec-4, dec-10 — ac-13): `channel` as a GuidanceTarget dimension.
//
// WHY. Some guidance names an affordance one surface cannot reach. The live case,
// shipping in nearly every footer today: "the same text the web UI's copy-prompt
// button produces." To an MCP coding agent that button does not exist — it is
// tokens spent describing a world the reader does not inhabit. This is the mirror
// of [std-34]'s honest-CTA rule: do not point a caller at something it has no way
// to use.
//
// WHY A TARGET DIMENSION AND NOT A BRANCH IN CODE. Per-channel prose is authored
// as TWO BLOCKS OF DATA in `scaffold-data.ts` [per std-15] — no projector emits
// different literals from an `if`. The dimension is what makes that possible.
//
// ⚠ IT IS THE SIXTH DIMENSION, NOT THE FIFTH. The Spec's prose says fifth in two
// places; spec-542 added `grounding?` in the interim. Harmless to the mechanism,
// but the count is wrong wherever it is written down.
//
// BACKWARD COMPATIBILITY IS THE LOAD-BEARING PROPERTY. Every block that exists
// today declares no channel, so every one of them must keep reaching both
// surfaces byte-for-byte. That is asserted below over the whole projection
// surface, not spot-checked — a regression here changes what every agent
// receives on every call.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toNudge, toNudgeBlocks } from './scaffold-model.js';
import type { GuidanceBlock, Phase } from './scaffold-model.js';

const AC_13 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-13';

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];
const GROUNDINGS = [undefined, 'not_grounded', 'grounded', 'grounded_stale'] as const;
const TOOLS: Array<string | undefined> = [undefined, ...BASE_SCAFFOLD.tools.map((t) => t.name)];

function block(over: Partial<GuidanceBlock> = {}): GuidanceBlock {
  return {
    kind: 'guidance_block',
    id: 'fixture',
    source: 'base',
    target: {},
    text: 'FIXTURE',
    enabled: true,
    order: 99,
    rationale: 'fixture',
    ...over,
  };
}

/** A dataset of just the fixture blocks, so channel behaviour is read without
 *  the 50-odd real blocks in the way. */
function datasetOf(...blocks: GuidanceBlock[]) {
  return { ...BASE_SCAFFOLD, baseGuidance: blocks };
}

describe('spec-510 t-5 — a channel-targeted block reaches only that channel (ac-13)', () => {
  it('matches its own channel and not the other', () => {
    tagAc(AC_13);
    const mcpOnly = block({ id: 'mcp-only', target: { channel: 'mcp' }, text: 'MCP ONLY' });
    const webOnly = block({ id: 'web-only', target: { channel: 'in_app_agent' }, text: 'WEB ONLY' });
    const ds = datasetOf(mcpOnly, webOnly);

    expect(toNudge({ dataset: ds, channel: 'mcp' })).toBe('MCP ONLY');
    expect(toNudge({ dataset: ds, channel: 'in_app_agent' })).toBe('WEB ONLY');
  });

  it('a channel-targeted block matches NEITHER when the channel is unknown', () => {
    tagAc(AC_13);
    // Same shape as spec-542's `grounding` clause, and correct for the same
    // reason: a caller that does not know the channel must assert nothing about
    // it, rather than defaulting to one and silently emitting the wrong prose.
    const ds = datasetOf(block({ id: 'mcp-only', target: { channel: 'mcp' }, text: 'MCP ONLY' }));
    expect(toNudge({ dataset: ds })).toBe('');
  });

  it('channel composes with the other dimensions rather than overriding them', () => {
    tagAc(AC_13);
    // The clause must stay an early `return false`, never an early `return true`
    // — as a positive match it would let channel override a phase or tool
    // mismatch. spec-542 recorded that trap for `grounding`; it is the same trap.
    const ds = datasetOf(
      block({ id: 'b', target: { channel: 'mcp', phase: 'build' }, text: 'MCP+BUILD' }),
    );
    expect(toNudge({ dataset: ds, channel: 'mcp', phase: 'build' })).toBe('MCP+BUILD');
    expect(toNudge({ dataset: ds, channel: 'mcp', phase: 'verify' })).toBe('');
    expect(toNudge({ dataset: ds, channel: 'in_app_agent', phase: 'build' })).toBe('');
  });
});

describe('spec-510 t-5 — backward compatible by construction (ac-13)', () => {
  it('an untargeted block reaches BOTH channels', () => {
    tagAc(AC_13);
    const ds = datasetOf(block({ id: 'everyone', target: {}, text: 'EVERYONE' }));
    expect(toNudge({ dataset: ds, channel: 'mcp' })).toBe('EVERYONE');
    expect(toNudge({ dataset: ds, channel: 'in_app_agent' })).toBe('EVERYONE');
    expect(toNudge({ dataset: ds })).toBe('EVERYONE');
  });

  it('the REAL Scaffold emits identically on both channels and with none, everywhere', () => {
    tagAc(AC_13);
    // No shipped block declares a channel, so adding the dimension must change
    // nothing for anyone. Checked across the whole surface rather than
    // spot-checked: a regression here alters what every agent receives on every
    // call, and a couple of examples would not see it.
    let compared = 0;
    for (const tool of TOOLS) {
      for (const phase of PHASES) {
        for (const grounding of GROUNDINGS) {
          const base = { dataset: BASE_SCAFFOLD, tool, phase, grounding } as Parameters<
            typeof toNudge
          >[0];
          const none = toNudge(base);
          expect(toNudge({ ...base, channel: 'mcp' })).toBe(none);
          expect(toNudge({ ...base, channel: 'in_app_agent' })).toBe(none);
          compared++;
        }
      }
    }
    expect(compared).toBe(TOOLS.length * PHASES.length * GROUNDINGS.length);
    expect(compared).toBeGreaterThan(100);
  });

  it('the block LIST is identical too, not just the joined text', () => {
    tagAc(AC_13);
    // toNudgeBlocks is what the cadence claims against (t-2/t-3). If the two
    // projections disagreed about channel, suppression would key off a different
    // set than the one emitted.
    const input = { dataset: BASE_SCAFFOLD, tool: 'get_doc', phase: 'build' as Phase };
    const none = toNudgeBlocks(input).map((b) => b.id);
    expect(toNudgeBlocks({ ...input, channel: 'mcp' }).map((b) => b.id)).toEqual(none);
    expect(toNudgeBlocks({ ...input, channel: 'in_app_agent' }).map((b) => b.id)).toEqual(none);
  });
});
