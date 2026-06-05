// b-68 t-4: toNudge edge-case coverage against the REAL `BASE_SCAFFOLD`.
//
// scaffold-model.test.ts exercises the projection contract with synthetic
// datasets. This file exercises the same projection against the actual base
// scaffold data so we catch regressions that only show up when the full
// (tool × phase) matrix is in play. Kept in its own file because the
// readability tradeoff is different: synthetic datasets are local + obvious,
// real-dataset assertions need negative matchers and dataset introspection.

import { describe, it, expect } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toNudge, type GuidanceBlock, type Phase } from './scaffold-model.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;

// Phases the BASE dataset carries. Used to drive the (tool × phase) sweeps.
const ALL_PHASES: readonly Phase[] = ['draft', 'plan', 'build', 'verify', 'done'];

// A representative sample across tool groups — read, mutate, lifecycle, AC,
// comment, slack. Keeps the per-phase loop tight while still covering each
// archetype the agent encounters.
const SAMPLE_TOOLS = [
  'get_doc',
  'list_memexes',
  'create_task',
  'update_section',
  'create_decision',
  'resolve_decision',
  'assess_spec',
  'create_ac',
  'add_comment',
] as const;

// Precedence-preamble negative matchers — anything that smells like a
// "base wins" / "never override" disclaimer must not appear in toNudge output.
// Per b-68 dec-3, the composed output reads as ONE coherent set of guidance,
// not a layered one with hedging language.
const PRECEDENCE_PATTERNS = [
  /never override/,
  /base wins/,
  /authoritative/,
  /precedence/,
  /refines but never/,
  /cannot contradict/,
];

// ──────────────────────────────────────────────────────────────────────────
// ac-12: no precedence preamble in toNudge against the REAL dataset.
// Exercise every phase × representative-tool combo and assert the negative
// matchers never trip.
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge against BASE_SCAFFOLD — no precedence preamble (ac-12)', () => {
  for (const phase of ALL_PHASES) {
    for (const tool of SAMPLE_TOOLS) {
      it(`(phase=${phase}, tool=${tool}) carries no "base wins" / "never override" disclaimer`, () => {
        tagAc(AC(12));

        const out = toNudge({ dataset: BASE_SCAFFOLD, tool, phase });
        const lower = out.toLowerCase();
        for (const pattern of PRECEDENCE_PATTERNS) {
          expect(lower, `precedence pattern ${pattern} matched in (${phase}, ${tool})`).not.toMatch(
            pattern,
          );
        }
      });
    }
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ac-25: tools that resolve no Spec at runtime get a phase-agnostic nudge.
// Passing `phase: undefined` MUST still return non-empty output (the global
// `target: {}` blocks) AND MUST NOT include any phase-specific intent text.
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge against BASE_SCAFFOLD — phase-agnostic fallback (ac-25)', () => {
  it('list_memexes (no phase) returns non-empty output drawn from global base blocks', () => {
    tagAc(AC(25));

    const out = toNudge({ dataset: BASE_SCAFFOLD, tool: 'list_memexes' });
    expect(out.length).toBeGreaterThan(0);
    // The four global cross-phase blocks (about-spec, mutation-protocol,
    // code-grounding, standards-protocol) are `target: {}` — every one of
    // them MUST appear when no phase / no tool filter discards them.
    const globalBlocks = BASE_SCAFFOLD.baseGuidance.filter(
      (b) =>
        b.target.phase === undefined &&
        b.target.tool === undefined &&
        b.target.transition === undefined,
    );
    expect(globalBlocks.length).toBeGreaterThan(0);
    for (const block of globalBlocks) {
      expect(out).toContain(block.text);
    }
  });

  it('list_memexes (no phase) excludes every phase-specific block', () => {
    tagAc(AC(25));

    const out = toNudge({ dataset: BASE_SCAFFOLD, tool: 'list_memexes' });

    // Every phase-tagged base block must be ABSENT from the phase-agnostic
    // output. Drives a stronger assertion than "the build intent string is
    // absent" — sweeps every phase-targeted block in the dataset.
    const phaseTaggedBlocks = BASE_SCAFFOLD.baseGuidance.filter(
      (b) => b.target.phase !== undefined,
    );
    expect(phaseTaggedBlocks.length).toBeGreaterThan(0);
    for (const block of phaseTaggedBlocks) {
      expect(
        out,
        `phase-specific block (phase=${block.target.phase}) leaked into phase-agnostic nudge`,
      ).not.toContain(block.text);
    }
  });

  it('list_memexes (no phase) excludes the build phase intent narrative specifically', () => {
    tagAc(AC(25));

    // Belt-and-braces: the per-phase `intent` text from the PhaseNode for
    // build is a load-bearing string. Make sure THAT exact prose doesn't
    // leak into a phase-agnostic call. Catches the most common drift mode
    // (somebody flattens the per-phase blocks into globals).
    const buildPhase = BASE_SCAFFOLD.phases.find((p) => p.phase === 'build');
    expect(buildPhase).toBeDefined();
    const buildIntentText = buildPhase!.intent;

    const out = toNudge({ dataset: BASE_SCAFFOLD, tool: 'list_memexes' });
    // The PhaseNode.intent itself isn't a guidance block — but its rendered
    // form ("**Phase:** build — execute against decisions; ...") IS, via
    // the per-phase intent guidance block. Either way it must not be here.
    expect(out).not.toContain(buildIntentText);
    expect(out).not.toContain('**Phase:** build');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-9: base-first merge against the REAL dataset with Org additions.
// Confirms ordering, disabled-Org exclusion, and `target.transition` exclusion
// when the base scaffold is the live one (not a hand-rolled stub).
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge against BASE_SCAFFOLD — base-first + enabled-Org merge (ac-9)', () => {
  const orgBlocks: readonly GuidanceBlock[] = [
    // Two enabled Org blocks targeted at (phase=build) — they should
    // appear AFTER every matching base block, in `order`.
    {
      kind: 'guidance_block',
      source: 'org',
      target: { phase: 'build' },
      text: 'ORG-BUILD-A',
      enabled: true,
      order: 1,
      rationale: 'Test fixture — first enabled org block in build.',
      orgId: 'org-1',
      authorId: 'user-1',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    },
    {
      kind: 'guidance_block',
      source: 'org',
      target: { phase: 'build' },
      text: 'ORG-BUILD-B',
      enabled: true,
      order: 2,
      rationale: 'Test fixture — second enabled org block in build.',
      orgId: 'org-1',
      authorId: 'user-1',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    },
    // Disabled Org block — must be filtered out.
    {
      kind: 'guidance_block',
      source: 'org',
      target: { phase: 'build' },
      text: 'ORG-BUILD-DISABLED',
      enabled: false,
      order: 3,
      rationale: 'Test fixture — disabled org block.',
      orgId: 'org-1',
      authorId: 'user-1',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    },
    // Transition-targeted Org block — belongs on the gate rubric, not the
    // nudge. Must be absent from toNudge output.
    {
      kind: 'guidance_block',
      source: 'org',
      target: { transition: 'build' },
      text: 'ORG-TRANSITION-BUILD',
      enabled: true,
      order: 4,
      rationale: 'Test fixture — transition block; rides toRubric, not toNudge.',
      orgId: 'org-1',
      authorId: 'user-1',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    },
  ];

  it('the first text in the output comes from a base GuidanceBlock (not Org)', () => {
    tagAc(AC(9));

    const out = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: 'create_task',
      phase: 'build',
      orgBlocks,
    });

    // The output is base-joined-by-blank-line. The first text segment must
    // map to a base block — never to an Org block — because base composes
    // first per b-68 dec-3.
    const firstSegment = out.split('\n\n')[0];
    expect(firstSegment).toBeDefined();

    const baseTexts = new Set(
      BASE_SCAFFOLD.baseGuidance.map((b) => b.text.split('\n\n')[0]),
    );
    // The first segment is itself the first paragraph of a base block; that
    // block's leading paragraph must be in the base-texts set.
    expect(baseTexts.has(firstSegment)).toBe(true);

    // Negative: the first segment is NOT one of the Org block texts.
    const orgTexts = orgBlocks.map((b) => b.text);
    expect(orgTexts).not.toContain(firstSegment);
  });

  it('Org content appears AFTER every base block that matches the same context', () => {
    tagAc(AC(9));

    const out = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: 'create_task',
      phase: 'build',
      orgBlocks,
    });

    // For every base block that matched the (create_task, build) context,
    // its position in the output must be BEFORE every enabled Org block's
    // position. The set of matching base blocks is everything that's either
    // global or phase=build.
    const matchingBaseBlocks = BASE_SCAFFOLD.baseGuidance.filter(
      (b) =>
        (b.target.phase === undefined || b.target.phase === 'build') &&
        b.target.tool === undefined &&
        b.target.transition === undefined,
    );
    expect(matchingBaseBlocks.length).toBeGreaterThan(0);

    const orgAIdx = out.indexOf('ORG-BUILD-A');
    const orgBIdx = out.indexOf('ORG-BUILD-B');
    expect(orgAIdx).toBeGreaterThan(-1);
    expect(orgBIdx).toBeGreaterThan(-1);

    for (const baseBlock of matchingBaseBlocks) {
      const baseIdx = out.indexOf(baseBlock.text);
      expect(baseIdx, `base block missing from output: ${baseBlock.text.slice(0, 60)}`).toBeGreaterThan(-1);
      expect(baseIdx).toBeLessThan(orgAIdx);
      expect(baseIdx).toBeLessThan(orgBIdx);
    }

    // Org blocks themselves are ordered by `order`.
    expect(orgAIdx).toBeLessThan(orgBIdx);
  });

  it('disabled Org blocks are absent from the output', () => {
    tagAc(AC(9));

    const out = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: 'create_task',
      phase: 'build',
      orgBlocks,
    });
    expect(out).not.toContain('ORG-BUILD-DISABLED');
  });

  it('blocks with target.transition are absent (they belong to toRubric)', () => {
    tagAc(AC(9));

    const out = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: 'create_task',
      phase: 'build',
      orgBlocks,
    });
    expect(out).not.toContain('ORG-TRANSITION-BUILD');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-9: drift sentinel — (tool × phase) completeness sweep against the real
// dataset. Doesn't assert on content; asserts that toNudge never throws and
// always returns a string. Empty is acceptable (some pairs have no matching
// base block); throwing is not.
// ──────────────────────────────────────────────────────────────────────────

describe('toNudge against BASE_SCAFFOLD — drift sentinel: every (tool × phase) is safe (ac-9)', () => {
  it('every (tool × phase) pair returns a string without throwing', () => {
    tagAc(AC(9));

    expect(BASE_SCAFFOLD.tools.length).toBeGreaterThan(0);
    expect(BASE_SCAFFOLD.phases.length).toBeGreaterThan(0);

    for (const toolNode of BASE_SCAFFOLD.tools) {
      for (const phaseNode of BASE_SCAFFOLD.phases) {
        const out = toNudge({
          dataset: BASE_SCAFFOLD,
          tool: toolNode.name,
          phase: phaseNode.phase,
        });
        expect(
          typeof out,
          `toNudge(${toolNode.name}, ${phaseNode.phase}) returned non-string`,
        ).toBe('string');
      }
    }
  });
});
