import { describe, it, expect } from 'vitest';
import {
  BASE_SCAFFOLD,
  toInitPromptRef,
  toolManifest,
  type InitPromptRefEntry,
  type ToolManifestEntry,
} from '@memex/shared';
import {
  renderSpecInitPrompt,
  MEMEX_MCP_TOOLS_REFERENCE,
  INIT_PROMPT_MODES,
  type InitPromptMode,
} from './specInitPrompt';
import { renderTaskInitPrompt } from './taskInitPrompt';
import type { DocWithGraph, Task, Comment } from '../api/types';
import { tagAc } from "@memex-ai-ac/vitest";

// b-68 t-9: the Init Prompt tool reference is now sourced from the unified
// scaffold model — `BASE_SCAFFOLD.tools` (@memex/shared), projected via
// `toInitPromptRef`. The legacy `renderToolManifest()` helper that read
// directly from `toolManifest` has been removed; `MEMEX_MCP_TOOLS_REFERENCE`
// stays as the consumer-visible export but its source has changed.
//
// These tests pin:
//   1. the rendering contract of the projected reference block,
//   2. that every spec mode wraps the rendered block in the hand-authored prose,
//   3. that the per-task prompt embeds the same block + task detail,
//   4. that NO disabled/removed tool reappears as a call anywhere,
//   5. (ac-27) that the rendered block derives from `BASE_SCAFFOLD.tools`
//      projected through `toInitPromptRef`,
//   6. (ac-26) that `toolManifest` and `BASE_SCAFFOLD.tools.map(toInitPromptRef)`
//      remain a 1:1 mirror — the b-67 manifest↔Zod parity contract is
//      preserved through the scaffold refactor.
//
// The parity guard (initPrompt-manifest-parity.test.ts) asserts the inverse —
// that every named tool ∈ manifest. This file asserts the model → output
// direction and the wrapper structure, without duplicating that guard.

// ── Fixtures (shape mirrors the existing init-prompt tests) ──────────────────

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'spec-uuid',
    memexId: 'memex-uuid',
    handle: 'spec-1',
    title: 'Migrate auth to scrypt',
    docType: 'spec',
    status: 'build',
    statusChangedAt: null,
    archivedAt: null,
    parentDocId: null,
    createdAt: '2026-05-01T00:00:00Z',
    sections: [
      { id: 's1', docId: 'spec-uuid', seq: 1, sectionType: 'context', title: 'Context', content: 'why', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' },
      { id: 's2', docId: 'spec-uuid', seq: 2, sectionType: 'approach', title: 'Approach', content: 'how', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' },
    ],
    decisions: [],
    tasks: [],
    ...overrides,
  } as DocWithGraph;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-uuid',
    docId: 'spec-uuid',
    seq: 7,
    title: 'Wire up the password verifier',
    description: 'Use Node scrypt with timing-safe compare.',
    acceptanceCriteria: [{ description: 'Verifier hits real DB user', done: false }],
    sectionRef: 'auth',
    status: 'not_started',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: '2026-05-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    executionPlanDocId: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    sectionId: null,
    decisionId: null,
    taskId: 'task-uuid',
    authorName: 'Reviewer',
    content: 'Add a test for the empty-input case',
    resolution: null,
    resolvedAt: null,
    createdAt: '2026-05-02T00:00:00Z',
    commentType: 'plan_revision',
    ...overrides,
  } as Comment;
}

// ── Spec replicas of the (non-exported) render constants ─────────────────────
// The render is private, so we re-declare the intended group order + headings
// here as the *specification*. If the implementation diverges, the assertions
// below catch it. Mirrors TOOL_GROUP_ORDER / TOOL_GROUP_HEADINGS in
// specInitPrompt.ts.
const EXPECTED_GROUP_ORDER: InitPromptRefEntry['group'][] = ['read', 'planning', 'build', 'comments'];
const EXPECTED_GROUP_HEADINGS: Record<InitPromptRefEntry['group'], string> = {
  read: '### Read (any phase)',
  planning: '### Specify phase (`draft` / `specify`)',
  build: '### Build phase (`build`)',
  comments: '### Comments (any phase)',
};

// The projected reference entries — the source of truth the render consumes.
// `BASE_SCAFFOLD.tools` is the unified-model record set; `toInitPromptRef`
// strips the scaffold-only fields back to the Init Prompt contract shape.
const REFERENCE_ENTRIES: InitPromptRefEntry[] = BASE_SCAFFOLD.tools.map(toInitPromptRef);

// Extract just the rendered tool-reference block from the exported reference.
// MEMEX_MCP_TOOLS_REFERENCE = [TOOLS_INTRO, renderToolReference(BASE_SCAFFOLD.tools), TOOLS_OUTRO]
// joined by '\n\n'. We slice between the first group heading and the OUTRO.
function manifestBlock(): string {
  const ref = MEMEX_MCP_TOOLS_REFERENCE;
  const firstHeading = EXPECTED_GROUP_HEADINGS[EXPECTED_GROUP_ORDER[0]];
  const start = ref.indexOf(firstHeading);
  // OUTRO begins with the phase-transition line.
  const outroMarker = '**Phase transitions are agent-driven except one:**';
  const end = ref.indexOf(outroMarker);
  expect(start, 'first group heading should be present in the reference').toBeGreaterThan(-1);
  expect(end, 'OUTRO marker should be present in the reference').toBeGreaterThan(start);
  return ref.slice(start, end).trim();
}

// One line per tool, as rendered: `` - `<args>` — <summary> ``.
function expectedToolLine(e: InitPromptRefEntry): string {
  return `- \`${e.args}\` — ${e.summary}`;
}

// ── 1. renderToolReference() rendering contract (via the exported block) ─────

describe('renderToolReference (rendered tool reference block)', () => {
  const block = manifestBlock();

  it('renders every BASE_SCAFFOLD tool exactly once, formatted from its exact args + summary', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-27');
    for (const e of REFERENCE_ENTRIES) {
      const line = expectedToolLine(e);
      const occurrences = block.split(line).length - 1;
      expect(occurrences, `tool ${e.name} should render exactly one formatted line`).toBe(1);
    }
  });

  it('the set of rendered tool names equals the set of names in BASE_SCAFFOLD.tools', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-27');
    // Every reference line is `- \`<name>(...)\` — ...`. Pull the leading
    // identifier of each bulleted, backticked tool line out of the block.
    const lineRe = /^- `([a-z][a-z0-9_]*(?:__[a-z0-9_]+)?)\(/gm;
    const rendered = new Set<string>();
    for (const m of block.matchAll(lineRe)) rendered.add(m[1]);

    const sourceNames = new Set(REFERENCE_ENTRIES.map((e) => e.name));
    expect([...rendered].sort()).toEqual([...sourceNames].sort());
  });

  it('groups each tool under the heading matching its group', () => {
    // For each group, the heading must precede every one of its tools, and no
    // tool from a different group may sit between this heading and its own tools.
    for (const group of EXPECTED_GROUP_ORDER) {
      const heading = EXPECTED_GROUP_HEADINGS[group];
      const headingIdx = block.indexOf(heading);
      const entries = REFERENCE_ENTRIES.filter((e) => e.group === group);
      // Heading present iff the group has ≥1 tool.
      if (entries.length === 0) {
        expect(headingIdx, `empty group ${group} should not render a heading`).toBe(-1);
        continue;
      }
      expect(headingIdx, `heading for non-empty group ${group} should render`).toBeGreaterThan(-1);

      // The next group's heading (if any) bounds this group's region.
      const laterHeadingIdxs = EXPECTED_GROUP_ORDER
        .map((g) => EXPECTED_GROUP_HEADINGS[g])
        .map((h) => block.indexOf(h))
        .filter((idx) => idx > headingIdx);
      const regionEnd = laterHeadingIdxs.length ? Math.min(...laterHeadingIdxs) : block.length;

      for (const e of entries) {
        const lineIdx = block.indexOf(expectedToolLine(e));
        expect(lineIdx, `tool ${e.name} should sit under its ${group} heading`).toBeGreaterThan(headingIdx);
        expect(lineIdx, `tool ${e.name} should sit before the next group heading`).toBeLessThan(regionEnd);
      }
    }
  });

  it('renders group headings in TOOL_GROUP_ORDER', () => {
    const headingIdxs = EXPECTED_GROUP_ORDER.filter(
      (g) => REFERENCE_ENTRIES.some((e) => e.group === g),
    ).map((g) => block.indexOf(EXPECTED_GROUP_HEADINGS[g]));
    const sorted = [...headingIdxs].sort((a, b) => a - b);
    expect(headingIdxs).toEqual(sorted);
  });

  it('only renders a heading for a group that has ≥1 tool', () => {
    for (const group of EXPECTED_GROUP_ORDER) {
      const hasTools = REFERENCE_ENTRIES.some((e) => e.group === group);
      const present = manifestBlock().includes(EXPECTED_GROUP_HEADINGS[group]);
      expect(present, `heading presence for ${group} should match tool presence`).toBe(hasTools);
    }
  });

  // ── ac-27: source-of-truth assertion ──────────────────────────────────────
  //
  // The Init Prompt's tool reference is produced by `toInitPromptRef()`
  // consuming the unified scaffold model. This is the load-bearing contract
  // for t-9: `MEMEX_MCP_TOOLS_REFERENCE` is no longer hand-coupled to
  // `toolManifest`; it derives from `BASE_SCAFFOLD.tools` via projection.

  it('the rendered block is byte-identical to a fresh projection of BASE_SCAFFOLD.tools', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-27');
    // Re-render the reference block from the source-of-truth data using the
    // same projection the implementation uses. If anyone hand-edits the prompt
    // text without going through the model, this assertion fails.
    const refs = BASE_SCAFFOLD.tools.map(toInitPromptRef);
    const fresh = EXPECTED_GROUP_ORDER.flatMap((group) => {
      const entries = refs.filter((e) => e.group === group);
      if (entries.length === 0) return [] as string[];
      const lines = entries.map((e) => `- \`${e.args}\` — ${e.summary}`);
      return [[EXPECTED_GROUP_HEADINGS[group], ...lines].join('\n')];
    }).join('\n\n');
    expect(block).toBe(fresh);
  });

  it('every BASE_SCAFFOLD tool projects to a non-empty InitPromptRefEntry', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-27');
    // The projection contract: rationale is stripped, the four reference
    // fields (name/summary/args/group) are preserved and non-empty.
    for (const tool of BASE_SCAFFOLD.tools) {
      const ref = toInitPromptRef(tool);
      expect(ref.name, `tool ${tool.name} must have a non-empty name`).toBeTruthy();
      expect(ref.summary, `tool ${tool.name} must have a non-empty summary`).toBeTruthy();
      expect(ref.args, `tool ${tool.name} must have a non-empty args`).toBeTruthy();
      expect(ref.group, `tool ${tool.name} must have a non-empty group`).toBeTruthy();
      // The projection must NOT leak the rationale field through.
      expect(
        (ref as unknown as Record<string, unknown>).rationale,
        `toInitPromptRef must strip rationale (${tool.name})`,
      ).toBeUndefined();
    }
  });
});

// ── 1b. ac-26: b-67 manifest↔Zod parity is preserved through the scaffold ────
//
// The b-67 regression test (packages/server/src/__regression__/) is the
// canonical guard that `toolManifest` matches the live Zod schemas. This file
// can't import server internals, but the t-9 refactor must NOT break the
// contract that `toolManifest` and the scaffold's tool list describe the same
// surface. We pin that invariant here: every entry in `toolManifest` has a
// matching ToolNode in `BASE_SCAFFOLD.tools` with identical name / summary /
// args / group. If a tool is added/removed/renamed only on one side, this
// fails before reaching the b-67 regression.

describe('b-67 manifest ↔ scaffold parity (ac-26)', () => {
  it('every toolManifest entry has a 1:1 BASE_SCAFFOLD.tools mirror (name/summary/args/group)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-26');
    expect(BASE_SCAFFOLD.tools.length).toBe(toolManifest.length);
    const byName = new Map(BASE_SCAFFOLD.tools.map((t) => [t.name, t]));
    for (const m of toolManifest) {
      const t = byName.get(m.name);
      expect(t, `manifest entry ${m.name} should have a matching ToolNode`).toBeDefined();
      if (!t) continue;
      expect(t.summary, `${m.name} summary should match`).toBe(m.summary);
      expect(t.args, `${m.name} args should match`).toBe(m.args);
      expect(t.group, `${m.name} group should match`).toBe(m.group);
    }
  });

  it('projecting BASE_SCAFFOLD.tools through toInitPromptRef yields the toolManifest set', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-26');
    // The projection contract: `toInitPromptRef` produces values of type
    // `InitPromptRefEntry` (= `ToolManifestEntry`). The set of projected
    // entries must equal the manifest as a multiset on (name/summary/args/group).
    const projected = BASE_SCAFFOLD.tools.map(toInitPromptRef);
    const norm = (e: ToolManifestEntry | InitPromptRefEntry) =>
      `${e.name}|${e.summary}|${e.args}|${e.group}`;
    expect(projected.map(norm).sort()).toEqual(toolManifest.map(norm).sort());
  });
});

// ── 2. renderSpecInitPrompt across ALL modes ────────────────────────────────

describe('renderSpecInitPrompt — wrapper prose + manifest block across all modes', () => {
  const modes = Object.keys(INIT_PROMPT_MODES) as InitPromptMode[];

  it('has at least one mode to exercise', () => {
    expect(modes.length).toBeGreaterThan(0);
  });

  for (const mode of modes) {
    describe(`mode: ${mode}`, () => {
      // For execute, the default `build` status renders the full body.
      const out = renderSpecInitPrompt(makeDoc(), 3, mode);

      it('embeds the full rendered tool-reference block', () => {
        expect(out).toContain(manifestBlock());
      });

      it('renders every BASE_SCAFFOLD tool line verbatim', () => {
        for (const e of REFERENCE_ENTRIES) {
          expect(out, `mode ${mode} missing tool line for ${e.name}`).toContain(expectedToolLine(e));
        }
      });

      it('includes the hand-authored TOOLS_INTRO heading', () => {
        expect(out).toContain('## Tools available to you');
        expect(out).toContain('You have access to the `memex` MCP server.');
      });

      it('includes the "Addressing things in Memex" ref-grammar block', () => {
        expect(out).toContain('### Addressing things in Memex');
        expect(out).toContain('<namespace>/<memex>/<doc-type>/<doc-handle>[/<child-type>/<child-handle>]');
        expect(out).toContain('Memex-scoped tools');
      });

      it('includes the closing TOOLS_OUTRO guidance (phase transition + error handling)', () => {
        expect(out).toContain('**Phase transitions are agent-driven except one:**');
        expect(out).toContain('`verify` → `done` is human-only');
        expect(out).toContain('**On errors:**');
      });

      it('renders a non-trivial prompt ending with a trailing newline', () => {
        expect(out.length).toBeGreaterThan(200);
        expect(out.endsWith('\n')).toBe(true);
      });
    });
  }
});

// ── 2b. execute mode is phase-gated on status ────────────────────────────────

describe('renderSpecInitPrompt — execute mode phase gate', () => {
  // Isolate just the "## How to start" focus block — the part the mode actually
  // varies. (The TOOLS reference precedes it and always lists every tool.)
  function focusBlock(out: string): string {
    const idx = out.lastIndexOf('## How to start');
    expect(idx, 'rendered prompt should have a "How to start" focus block').toBeGreaterThan(-1);
    return out.slice(idx);
  }

  it('renders the full execute body when the spec is in a build-or-later status', () => {
    for (const status of ['build', 'verify', 'implementation'] as const) {
      const out = renderSpecInitPrompt(makeDoc({ status }), 3, 'execute');
      expect(out, `status ${status} should not short-circuit`).not.toContain('⚠ **Wrong phase.**');
      // The execute focus body walks the build loop tools.
      const focus = focusBlock(out);
      expect(focus, `status ${status} should walk list_tasks`).toContain('list_tasks(');
      expect(focus).toContain('update_task(');
      expect(focus).toContain('search_memex(');
    }
  });

  it('short-circuits to a wrong-phase warning when the spec is still specifying', () => {
    for (const status of ['draft', 'specify'] as const) {
      const out = renderSpecInitPrompt(makeDoc({ status }), 2, 'execute');
      expect(out, `status ${status} should warn`).toContain('⚠ **Wrong phase.**');
      expect(out).toContain(`This Spec is in \`${status}\``);
      // It tells the agent to switch to specify mode rather than run tasks.
      expect(out).toContain('switch to specify mode');
      // The wrong-phase FOCUS block does NOT walk the build loop (list_tasks
      // still appears in the always-present manifest reference above it).
      expect(focusBlock(out)).not.toContain('list_tasks(');
      // But the manifest block is still present (it precedes the focus block).
      expect(out).toContain(manifestBlock());
    }
  });

  it('singularises the open-decision count in the wrong-phase warning', () => {
    const one = renderSpecInitPrompt(
      makeDoc({ status: 'specify', decisions: [{ id: 'd1', docId: 'spec-uuid', seq: 1, title: 'x', context: null, status: 'open', resolution: null, createdAt: '2026-05-01T00:00:00Z', resolvedAt: null } as never] }),
      0,
      'execute',
    );
    expect(one).toContain('1 open decision first');
    const many = renderSpecInitPrompt(
      makeDoc({
        status: 'specify',
        decisions: [
          { id: 'd1', docId: 'spec-uuid', seq: 1, title: 'x', context: null, status: 'open', resolution: null, createdAt: '2026-05-01T00:00:00Z', resolvedAt: null } as never,
          { id: 'd2', docId: 'spec-uuid', seq: 2, title: 'y', context: null, status: 'open', resolution: null, createdAt: '2026-05-01T00:00:00Z', resolvedAt: null } as never,
        ],
      }),
      0,
      'execute',
    );
    expect(many).toContain('2 open decisions first');
  });
});

// ── 3. renderTaskInitPrompt embeds the same manifest-driven reference ─────────

describe('renderTaskInitPrompt — manifest reference + task detail', () => {
  it('embeds the full rendered tool-reference block and every tool line', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask(), [makeComment()]);
    expect(out).toContain(manifestBlock());
    for (const e of REFERENCE_ENTRIES) {
      expect(out, `task prompt missing tool line for ${e.name}`).toContain(expectedToolLine(e));
    }
    // The hand-authored wrapper prose travels with the block.
    expect(out).toContain('## Tools available to you');
    expect(out).toContain('### Addressing things in Memex');
    expect(out).toContain('**Phase transitions are agent-driven except one:**');
  });

  it('reflects task detail for a not-blocked task', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask({ blocked: false }), [makeComment()]);
    expect(out).toContain('T-7 — Wire up the password verifier');
    expect(out).toContain('## Task T-7: Wire up the password verifier');
    expect(out).toContain('Use Node scrypt with timing-safe compare.');
    expect(out).toContain('- [ ] Verifier hits real DB user');
    // The open comment surfaces.
    expect(out).toContain('Open comments on this task');
    expect(out).toContain('Add a test for the empty-input case');
    // Not-blocked → no blocker callout.
    expect(out).not.toContain('Blocked by:');
    expect(out).not.toContain('(blocked)');
  });

  it('reflects blocker detail for a blocked task', () => {
    const blocker = {
      id: 'dec-block',
      docId: 'spec-uuid',
      seq: 4,
      title: 'Salt handling for legacy rows',
      context: null,
      status: 'open' as const,
      resolution: null,
      createdAt: '2026-05-01T00:00:00Z',
      resolvedAt: null,
    };
    const out = renderTaskInitPrompt(
      makeDoc({ decisions: [blocker as never] }),
      makeTask({ blocked: true, blockedByDecisions: [blocker as never] }),
    );
    expect(out).toContain('T-7 — Wire up the password verifier');
    // Header marks the task blocked.
    expect(out).toContain('**Status:** not_started (blocked)');
    // Blocker callout names the decision.
    expect(out).toContain('**Blocked by:** D-4 (Salt handling for legacy rows)');
    expect(out).toContain("Resolve the blockers");
    // And it appears in the decisions summary as blocking this task.
    expect(out).toContain('**blocks this task**');
  });
});

// ── 4. Drift-direction coverage: no disabled/removed tool reappears ──────────

describe('drift guard — disabled/removed tools never reappear as calls', () => {
  // Tools that the b-67 cleanup removed/disabled. None may show up as a
  // call-shaped `name(` mention in any rendered prompt. These names are NOT in
  // the manifest, so the parity guard would also catch a regression — but this
  // pins the specific cleanup so it can't silently come back.
  //
  // spec-143 deliberately RESTORED `flag_drift` and `propose_standard_change`
  // to the live manifest (the drift agent's confirmation-gated mutation
  // surface — commit 94c445f), so they are no longer "removed" and were
  // dropped from this list. If either is pruned again, re-add it here.
  const REMOVED_TOOLS = [
    'list_briefs',
    'list_specs',
    'find_symbol',
    'get_dependencies',
    'code_search',
    'get_symbol',
    'list_symbols',
    'get_ready_tasks',
    'reopen_decision',
    'update_task_status',
  ];

  // Reuse the same call-shape regex as the parity guard so "as a call" means
  // the same thing in both files.
  const CALL_RE = /`?([a-z][a-z0-9_]*(?:__[a-z0-9_]+)?)\(/g;
  function callNames(text: string): Set<string> {
    const names = new Set<string>();
    for (const m of text.matchAll(CALL_RE)) names.add(m[1]);
    return names;
  }

  function everyRenderedPrompt(): string {
    const doc = makeDoc();
    const modes = (Object.keys(INIT_PROMPT_MODES) as InitPromptMode[]).map((mode) =>
      renderSpecInitPrompt(doc, 3, mode),
    );
    // Also exercise the execute wrong-phase branch and a blocked task path.
    modes.push(renderSpecInitPrompt(makeDoc({ status: 'specify' }), 1, 'execute'));
    const task = renderTaskInitPrompt(doc, makeTask(), [makeComment()]);
    const blockedTask = renderTaskInitPrompt(
      makeDoc({ status: 'specify' }),
      makeTask({ blocked: true }),
      [],
    );
    return [...modes, task, blockedTask].join('\n\n');
  }

  it('none of the removed/disabled tools appear as a call in any prompt', () => {
    const calls = callNames(everyRenderedPrompt());
    const offenders = REMOVED_TOOLS.filter((name) => calls.has(name));
    expect(
      offenders,
      `Removed/disabled tools reappeared as call-shaped mentions: ${offenders.join(', ')}. ` +
        'The b-67 cleanup pruned these; if one is back, the prompt prose or manifest regressed.',
    ).toEqual([]);
  });

  it('sanity: the removed-tools list is disjoint from the live tool surface', () => {
    const sourceNames = new Set(REFERENCE_ENTRIES.map((e) => e.name));
    const collisions = REMOVED_TOOLS.filter((n) => sourceNames.has(n));
    expect(collisions, 'a "removed" tool is actually still in BASE_SCAFFOLD.tools').toEqual([]);
  });
});
