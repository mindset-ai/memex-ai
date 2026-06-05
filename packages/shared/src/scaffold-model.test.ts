// b-68 t-1: tests for the scaffold model.
//
// Type-level + behavioural tests exercising the discriminated union, the
// dec-2 GuidanceBlock contract, and the projection contracts. Real merge /
// surface behaviour (every (tool × phase) shape, base+Org ordering, gate
// rubric composition) is broadened in t-4 and t-5.

import { describe, it, expect, assertType } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import type { ToolManifestEntry } from './tool-manifest.js';
import {
  toNudge,
  toRubric,
  toPromptBlocks,
  toToolDefinition,
  toInitPromptRef,
  type GuidanceBlock,
  type PhaseNode,
  type PromptBlockNode,
  type ScaffoldDataset,
  type ScaffoldNode,
  type ToolNode,
  type TransitionRubric,
} from './scaffold-model.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;

// ── helpers ──────────────────────────────────────────────────────────────

function makePromptBlock(overrides: Partial<PromptBlockNode> = {}): PromptBlockNode {
  return {
    kind: 'prompt_block',
    id: overrides.id ?? 'role',
    text: overrides.text ?? 'You are the Memex agent.',
    surface: overrides.surface ?? 'react_only',
    rationale: overrides.rationale ?? 'Orientation block for the React agent.',
  };
}

function makePhase(overrides: Partial<PhaseNode> = {}): PhaseNode {
  return {
    kind: 'phase',
    phase: overrides.phase ?? 'build',
    intent: overrides.intent ?? 'execute against decisions.',
    allowance: overrides.allowance ?? { allowed: [], blocked: [] },
    promptBlockIds: overrides.promptBlockIds ?? ['role'],
    rationale: overrides.rationale ?? 'Phase intent + prompt composition for build.',
  };
}

function makeTool(overrides: Partial<ToolNode> = {}): ToolNode {
  return {
    kind: 'tool',
    name: overrides.name ?? 'create_task',
    summary: overrides.summary ?? 'Create a task.',
    args: overrides.args ?? 'create_task(ref, title, description)',
    group: overrides.group ?? 'build',
    annotations: overrides.annotations,
    rationale: overrides.rationale ?? 'Build-phase task creation.',
  };
}

function makeRubric(overrides: Partial<TransitionRubric> = {}): TransitionRubric {
  return {
    kind: 'transition_rubric',
    transition: overrides.transition ?? 'build',
    text: overrides.text ?? 'BASE RUBRIC: decisions resolved? narrative consolidated?',
    rationale: overrides.rationale ?? 'Gate rubric for ->build.',
  };
}

function makeBaseBlock(overrides: Partial<GuidanceBlock> = {}): GuidanceBlock {
  return {
    kind: 'guidance_block',
    source: 'base',
    target: overrides.target ?? {},
    text: overrides.text ?? 'BASE: read decisions before writing tasks.',
    enabled: overrides.enabled ?? true,
    order: overrides.order ?? 0,
    rationale: overrides.rationale ?? 'Base guidance line.',
    ...(overrides.emphasis ? { emphasis: overrides.emphasis } : {}),
  };
}

function makeOrgBlock(overrides: Partial<GuidanceBlock> = {}): GuidanceBlock {
  return {
    ...makeBaseBlock(overrides),
    source: 'org',
    orgId: overrides.orgId ?? 'org-1',
    authorId: overrides.authorId ?? 'user-1',
    createdAt: overrides.createdAt ?? '2026-05-27T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-05-27T00:00:00Z',
    text: overrides.text ?? 'ORG: link the related Linear ticket in every Spec.',
  };
}

const EMPTY_DATASET: ScaffoldDataset = {
  phases: [],
  promptBlocks: [],
  tools: [],
  transitions: [],
  baseGuidance: [],
  promptButtons: [],
};

// ── ac-16: ScaffoldNode discriminated union ──────────────────────────────

describe('ScaffoldNode discriminated union (ac-16)', () => {
  it('narrows via the `kind` discriminator', () => {
    tagAc(AC(16));

    const nodes: ScaffoldNode[] = [
      makePhase(),
      makePromptBlock(),
      makeTool(),
      makeRubric(),
      makeBaseBlock(),
    ];

    const summarise = (n: ScaffoldNode): string => {
      switch (n.kind) {
        case 'phase':
          return `phase:${n.phase}`;
        case 'prompt_block':
          return `prompt:${n.id}`;
        case 'tool':
          return `tool:${n.name}`;
        case 'transition_rubric':
          return `rubric:${n.transition}`;
        case 'guidance_block':
          return `guidance:${n.source}`;
      }
    };

    expect(nodes.map(summarise)).toEqual([
      'phase:build',
      'prompt:role',
      'tool:create_task',
      'rubric:build',
      'guidance:base',
    ]);
  });

  it('treats the kind set as exhaustive — exhaustive switch type-checks', () => {
    tagAc(AC(16));

    function neverReached(n: never): never {
      throw new Error(`unreachable: ${JSON.stringify(n)}`);
    }

    function summarise(n: ScaffoldNode): string {
      switch (n.kind) {
        case 'phase':
        case 'prompt_block':
        case 'tool':
        case 'transition_rubric':
        case 'guidance_block':
          return n.kind;
        default:
          return neverReached(n);
      }
    }

    expect(summarise(makePhase())).toBe('phase');
  });
});

// ── ac-17: ToolNode extends ToolManifestEntry ────────────────────────────

describe('ToolNode extends ToolManifestEntry (ac-17)', () => {
  it('keeps the b-67 manifest fields with their original names and types', () => {
    tagAc(AC(17));

    const tool = makeTool({ name: 'list_tasks', summary: 'List tasks.', args: 'list_tasks(ref)', group: 'read' });
    // Structural assignment: a ToolNode IS-A ToolManifestEntry.
    const manifestEntry: ToolManifestEntry = tool;
    expect(manifestEntry.name).toBe('list_tasks');
    expect(manifestEntry.summary).toBe('List tasks.');
    expect(manifestEntry.args).toBe('list_tasks(ref)');
    expect(manifestEntry.group).toBe('read');

    // Type-level: ToolNode is assignable to ToolManifestEntry. Verified at
    // compile time; the runtime assertion is the structural check above.
    assertType<ToolManifestEntry>(tool);
  });

  it('adds annotations and rationale without renaming inherited fields', () => {
    tagAc(AC(17));

    const tool = makeTool({
      annotations: { title: 'Create Task', destructiveHint: false },
      rationale: 'Build-phase task creation lives behind this tool.',
    });
    expect(tool.annotations?.title).toBe('Create Task');
    expect(tool.rationale).toBe('Build-phase task creation lives behind this tool.');
    // Inherited fields untouched.
    expect(tool.name).toBe('create_task');
  });
});

// ── ac-7: GuidanceBlock shape matches dec-2 ──────────────────────────────

describe('GuidanceBlock shape matches dec-2 record (ac-7)', () => {
  it('base record carries the dec-2 required fields and no Org metadata', () => {
    tagAc(AC(7));

    const block = makeBaseBlock({
      target: { phase: 'build', tool: 'create_task' },
      text: 'Use the AC ref before writing the test body.',
      emphasis: 'do',
      enabled: true,
      order: 3,
      rationale: 'Why this rule exists.',
    });

    expect(block.kind).toBe('guidance_block');
    expect(block.source).toBe('base');
    expect(block.target).toEqual({ phase: 'build', tool: 'create_task' });
    expect(block.text).toBe('Use the AC ref before writing the test body.');
    expect(block.emphasis).toBe('do');
    expect(block.enabled).toBe(true);
    expect(block.order).toBe(3);
    expect(block.rationale).toBe('Why this rule exists.');
    expect(block.orgId).toBeUndefined();
    expect(block.authorId).toBeUndefined();
    expect(block.createdAt).toBeUndefined();
    expect(block.updatedAt).toBeUndefined();
  });

  it('Org record carries source=org plus org_id / author_id / timestamps', () => {
    tagAc(AC(7));

    const block = makeOrgBlock({
      target: { tool: 'create_decision' },
      text: 'Link a Linear ticket if one exists.',
      orgId: 'mindset-prod',
      authorId: 'user-42',
      createdAt: '2026-05-26T10:00:00Z',
      updatedAt: '2026-05-27T11:00:00Z',
    });

    expect(block.source).toBe('org');
    expect(block.orgId).toBe('mindset-prod');
    expect(block.authorId).toBe('user-42');
    expect(block.createdAt).toBe('2026-05-26T10:00:00Z');
    expect(block.updatedAt).toBe('2026-05-27T11:00:00Z');
  });
});

// ── ac-6: target shape + per-Org scoping ─────────────────────────────────

describe('GuidanceBlock.target shape (ac-6)', () => {
  it('accepts phase / tool / transition independently or together', () => {
    tagAc(AC(6));

    const phaseOnly = makeBaseBlock({ target: { phase: 'build' } });
    const toolOnly = makeBaseBlock({ target: { tool: 'create_task' } });
    const phaseAndTool = makeBaseBlock({ target: { phase: 'build', tool: 'create_task' } });
    const transitionOnly = makeBaseBlock({ target: { transition: 'build' } });
    const allFields = makeBaseBlock({ target: { phase: 'build', tool: 'create_task', transition: 'build' } });
    const noTarget = makeBaseBlock({ target: {} });

    expect(phaseOnly.target.phase).toBe('build');
    expect(toolOnly.target.tool).toBe('create_task');
    expect(phaseAndTool.target.phase).toBe('build');
    expect(phaseAndTool.target.tool).toBe('create_task');
    expect(transitionOnly.target.transition).toBe('build');
    expect(allFields.target).toEqual({ phase: 'build', tool: 'create_task', transition: 'build' });
    expect(noTarget.target).toEqual({});
  });

  it('absent target field matches every value in toNudge (per dec-1)', () => {
    tagAc(AC(6));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [
        makeBaseBlock({ target: {}, text: 'global', order: 0 }),
        makeBaseBlock({ target: { phase: 'build' }, text: 'build-only', order: 1 }),
        makeBaseBlock({ target: { tool: 'create_task' }, text: 'create_task-only', order: 2 }),
      ],
    };

    // (tool: 'create_task', phase: 'build') matches all three.
    const both = toNudge({ dataset, tool: 'create_task', phase: 'build' });
    expect(both).toContain('global');
    expect(both).toContain('build-only');
    expect(both).toContain('create_task-only');

    // (tool: 'list_docs', phase: 'plan') matches only the org-global one.
    const neither = toNudge({ dataset, tool: 'list_docs', phase: 'plan' });
    expect(neither).toContain('global');
    expect(neither).not.toContain('build-only');
    expect(neither).not.toContain('create_task-only');
  });
});

// ── ac-9: toNudge merge contract (base-first, ordered, enabled-Org only) ─

describe('toNudge merge contract (ac-9)', () => {
  it('returns base blocks first, then enabled Org blocks, each ordered by `order`', () => {
    tagAc(AC(9));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [
        makeBaseBlock({ text: 'BASE-2', order: 2, target: { phase: 'build' } }),
        makeBaseBlock({ text: 'BASE-1', order: 1, target: { phase: 'build' } }),
      ],
    };
    const org: GuidanceBlock[] = [
      makeOrgBlock({ text: 'ORG-2', order: 2, target: { phase: 'build' } }),
      makeOrgBlock({ text: 'ORG-1', order: 1, target: { phase: 'build' } }),
    ];

    const out = toNudge({ dataset, tool: 'create_task', phase: 'build', orgBlocks: org });
    expect(out.split('\n\n')).toEqual(['BASE-1', 'BASE-2', 'ORG-1', 'ORG-2']);
  });

  it('excludes disabled Org blocks', () => {
    tagAc(AC(9));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [makeBaseBlock({ text: 'BASE', target: { phase: 'build' } })],
    };
    const org: GuidanceBlock[] = [
      makeOrgBlock({ text: 'ORG-ENABLED', target: { phase: 'build' }, enabled: true }),
      makeOrgBlock({ text: 'ORG-DISABLED', target: { phase: 'build' }, enabled: false }),
    ];

    const out = toNudge({ dataset, tool: 'create_task', phase: 'build', orgBlocks: org });
    expect(out).toContain('BASE');
    expect(out).toContain('ORG-ENABLED');
    expect(out).not.toContain('ORG-DISABLED');
  });

  it('excludes `target.transition` blocks — those ride the gate rubric, not the nudge', () => {
    tagAc(AC(9));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [
        makeBaseBlock({ text: 'PHASE-BUILD', target: { phase: 'build' } }),
        makeBaseBlock({ text: 'TRANSITION-BUILD', target: { transition: 'build' } }),
      ],
    };
    const out = toNudge({ dataset, phase: 'build' });
    expect(out).toContain('PHASE-BUILD');
    expect(out).not.toContain('TRANSITION-BUILD');
  });

  it('returns NO precedence preamble or "base wins" disclaimer (per dec-3)', () => {
    tagAc(AC(9));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [makeBaseBlock({ text: 'BASE', target: {} })],
    };
    const out = toNudge({ dataset, tool: 'create_task', phase: 'build' });
    expect(out.toLowerCase()).not.toMatch(/never override/);
    expect(out.toLowerCase()).not.toMatch(/base wins/);
    expect(out.toLowerCase()).not.toMatch(/authoritative/);
    expect(out.toLowerCase()).not.toMatch(/precedence/);
  });

  it('phase-agnostic fallback: undefined phase still resolves a nudge for tools that resolve no Spec (per dec-7)', () => {
    tagAc(AC(9));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [
        makeBaseBlock({ text: 'GLOBAL', target: {} }),
        makeBaseBlock({ text: 'PHASE-BUILD', target: { phase: 'build' } }),
      ],
    };
    const out = toNudge({ dataset, tool: 'list_memexes' });
    expect(out).toContain('GLOBAL');
    expect(out).not.toContain('PHASE-BUILD'); // phase-specific filtered when no phase context
  });
});

// ── ac-14: rationale on every node, never in projection outputs ──────────

describe('rationale is structural + never sent to the agent (ac-14)', () => {
  it('every ScaffoldNode kind requires a rationale string at the type level', () => {
    tagAc(AC(14));

    // If any of these required `rationale: string` to be omittable, the
    // factories below would compile without it. The factories always set it,
    // so the runtime guard is a non-empty check.
    expect(makePhase().rationale).toBeTruthy();
    expect(makePromptBlock().rationale).toBeTruthy();
    expect(makeTool().rationale).toBeTruthy();
    expect(makeRubric().rationale).toBeTruthy();
    expect(makeBaseBlock().rationale).toBeTruthy();
  });

  it('toPromptBlocks output contains no rationale text', () => {
    tagAc(AC(14));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      phases: [makePhase({ phase: 'build', promptBlockIds: ['role'] })],
      promptBlocks: [
        makePromptBlock({
          id: 'role',
          surface: 'react_only',
          text: 'You are the Memex agent.',
          rationale: 'RATIONALE-SENTINEL-PROMPT',
        }),
      ],
    };
    const blocks = toPromptBlocks(dataset, 'build');
    expect(blocks).toHaveLength(1);
    for (const b of blocks) {
      expect(b.text).not.toContain('RATIONALE-SENTINEL-PROMPT');
    }
  });

  it('toToolDefinition output contains no rationale text', () => {
    tagAc(AC(14));

    const tool = makeTool({ rationale: 'RATIONALE-SENTINEL-TOOL' });
    const def = toToolDefinition(tool);
    expect(JSON.stringify(def)).not.toContain('RATIONALE-SENTINEL-TOOL');
  });

  it('toInitPromptRef output contains no rationale text', () => {
    tagAc(AC(14));

    const tool = makeTool({ rationale: 'RATIONALE-SENTINEL-INIT' });
    const ref = toInitPromptRef(tool);
    expect(JSON.stringify(ref)).not.toContain('RATIONALE-SENTINEL-INIT');
  });

  it('toNudge output contains no rationale text', () => {
    tagAc(AC(14));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      baseGuidance: [
        makeBaseBlock({ target: { phase: 'build' }, text: 'visible', rationale: 'RATIONALE-SENTINEL-NUDGE-BASE' }),
      ],
    };
    const orgBlocks = [
      makeOrgBlock({ target: { phase: 'build' }, text: 'visible-org', rationale: 'RATIONALE-SENTINEL-NUDGE-ORG' }),
    ];
    const out = toNudge({ dataset, tool: 'create_task', phase: 'build', orgBlocks });
    expect(out).not.toContain('RATIONALE-SENTINEL-NUDGE-BASE');
    expect(out).not.toContain('RATIONALE-SENTINEL-NUDGE-ORG');
  });

  it('toRubric output contains no rationale text', () => {
    tagAc(AC(14));

    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      transitions: [makeRubric({ transition: 'build', rationale: 'RATIONALE-SENTINEL-RUBRIC-BASE' })],
    };
    const orgBlocks = [
      makeOrgBlock({ target: { transition: 'build' }, text: 'org-check', rationale: 'RATIONALE-SENTINEL-RUBRIC-ORG' }),
    ];
    const out = toRubric({ dataset, transition: 'build', orgBlocks });
    expect(out).not.toContain('RATIONALE-SENTINEL-RUBRIC-BASE');
    expect(out).not.toContain('RATIONALE-SENTINEL-RUBRIC-ORG');
  });
});

// ── toRubric: separate from nudges, composes base + Org per-transition ───

describe('toRubric composition', () => {
  it('composes base rubric prose followed by enabled Org {transition} blocks, ordered', () => {
    const dataset: ScaffoldDataset = {
      ...EMPTY_DATASET,
      transitions: [makeRubric({ transition: 'build', text: 'BASE: walk readiness rubric.' })],
    };
    const orgBlocks = [
      makeOrgBlock({ target: { transition: 'build' }, text: 'ORG-CHECK-B', order: 2 }),
      makeOrgBlock({ target: { transition: 'build' }, text: 'ORG-CHECK-A', order: 1 }),
      makeOrgBlock({ target: { transition: 'verify' }, text: 'WRONG-TRANSITION', order: 0 }),
      makeOrgBlock({ target: { transition: 'build' }, text: 'DISABLED', order: 99, enabled: false }),
    ];
    const out = toRubric({ dataset, transition: 'build', orgBlocks });
    expect(out.split('\n\n')).toEqual([
      'BASE: walk readiness rubric.',
      'ORG-CHECK-A',
      'ORG-CHECK-B',
    ]);
  });
});

// ── toInitPromptRef preserves b-67's ToolManifestEntry shape ─────────────

describe('toInitPromptRef preserves ToolManifestEntry shape', () => {
  it('returns a ToolManifestEntry-compatible value', () => {
    const ref = toInitPromptRef(makeTool({ name: 'get_doc', summary: 'Get a document.', args: 'get_doc(ref)', group: 'read' }));
    const asManifestEntry: ToolManifestEntry = ref;
    expect(asManifestEntry).toEqual({
      name: 'get_doc',
      summary: 'Get a document.',
      args: 'get_doc(ref)',
      group: 'read',
    });
  });
});
