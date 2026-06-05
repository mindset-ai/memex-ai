import { describe, it, expect } from 'vitest';
import { toolManifest } from '@memex/shared';
import { renderSpecInitPrompt, INIT_PROMPT_MODES, type InitPromptMode } from './specInitPrompt';
import { renderTaskInitPrompt } from './taskInitPrompt';
import type { DocWithGraph, Task, Comment } from '../api/types';

// b-67 t-5: integration guard. The Init Prompt is the briefing we paste into a
// fresh coding agent — every tool it names by call syntax must be a real MCP
// tool. The single source of truth for the live tool surface is `toolManifest`
// in @memex/shared. If the hand-authored wrapper prose (or a mode focus block)
// names a tool that isn't in the manifest — a renamed, removed, or temporarily
// disabled tool — this test fails, listing the offenders.

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'spec-uuid',
    memexId: 'memex-uuid',
    handle: 'spec-1',
    title: 'Migrate auth to scrypt',
    docType: 'spec',
    // `build` so the `execute` mode renders its full body (not the wrong-phase
    // short-circuit) — that block names the most tools, so we want it exercised.
    status: 'build',
    statusChangedAt: null,
    archivedAt: null,
    parentDocId: null,
    createdAt: '2026-05-01T00:00:00Z',
    sections: [],
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

/** Concatenate every Init Prompt surface: a spec prompt per mode, plus the
 *  per-task prompt. This is the full text an agent might ever be handed. */
function allInitPromptText(): string {
  const doc = makeDoc();
  const specVariants = (Object.keys(INIT_PROMPT_MODES) as InitPromptMode[]).map((mode) =>
    renderSpecInitPrompt(doc, 3, mode),
  );
  const taskPrompt = renderTaskInitPrompt(doc, makeTask(), [makeComment()]);
  return [...specVariants, taskPrompt].join('\n\n');
}

// Capture the identifier immediately preceding a `(`. Snake-case lower-ident,
// optionally with a `__namespace` segment (e.g. `memex__send_slack_message`).
// This matches the call-shaped tool mentions we render, e.g. `get_doc(` and
// `update_task(`.
const CALL_RE = /`?([a-z][a-z0-9_]*(?:__[a-z0-9_]+)?)\(/g;

function extractCallNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(CALL_RE)) names.push(m[1]);
  return names;
}

describe('Init Prompt ↔ tool manifest parity', () => {
  const manifestNames = new Set(toolManifest.map((e) => e.name));

  it('names only tools that exist in the manifest', () => {
    const text = allInitPromptText();
    const called = extractCallNames(text);

    // Sanity: the prompt does mention some tools, so the guard is actually
    // looking at something.
    expect(called.length).toBeGreaterThan(0);

    const offenders = [...new Set(called.filter((name) => !manifestNames.has(name)))].sort();
    expect(
      offenders,
      `Init Prompt names tools absent from toolManifest (@memex/shared): ${offenders.join(', ')}. ` +
        'Either the tool was renamed/removed/disabled, or the prompt prose drifted. ' +
        'Update the wrapper prose in specInitPrompt.ts / taskInitPrompt.ts (or the manifest).',
    ).toEqual([]);
  });

  it('exercises every spec mode plus the task prompt (guard has coverage)', () => {
    const modes = Object.keys(INIT_PROMPT_MODES) as InitPromptMode[];
    expect(modes.length).toBeGreaterThan(0);
    // Every mode renders without throwing and produces a non-trivial prompt.
    for (const mode of modes) {
      const out = renderSpecInitPrompt(makeDoc(), 3, mode);
      expect(out.length).toBeGreaterThan(100);
    }
    const taskOut = renderTaskInitPrompt(makeDoc(), makeTask(), [makeComment()]);
    expect(taskOut.length).toBeGreaterThan(100);
  });
});
