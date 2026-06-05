import { describe, it, expect } from 'vitest';
import { renderTaskInitPrompt } from './taskInitPrompt';
import type { DocWithGraph, Task, Decision, Comment } from '../api/types';

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'spec-uuid',
    memexId: 'memex-uuid',
    handle: 'spec-1',
    title: 'Migrate auth to scrypt',
    docType: 'spec',
    status: 'implementation',
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
    acceptanceCriteria: [
      { description: 'Verifier hits real DB user', done: false },
      { description: 'Timing-safe compare in place', done: true },
    ],
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

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `dec-${Math.random()}`,
    docId: 'spec-uuid',
    seq: 1,
    title: 'Hashing scheme',
    context: null,
    status: 'open',
    resolution: null,
    createdAt: '2026-05-01T00:00:00Z',
    resolvedAt: null,
    ...overrides,
  } as Decision;
}

describe('renderTaskInitPrompt', () => {
  it('embeds the spec, task, and the canonical MCP tools reference', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask());
    expect(out).toContain('Migrate auth to scrypt');
    expect(out).toContain('`spec-1`');
    expect(out).toContain('T-7 — Wire up the password verifier');
    // The shared MCP tools block is in here verbatim — agents need it to
    // know what to call.
    expect(out).toContain('`memex` MCP server');
    // T-6: entity-acting tools take a single `ref` (canonical path).
    expect(out).toContain('get_doc(ref)');
    // doc-14: update_task_status folded into update_task({ status }).
    expect(out).toContain('update_task');
    // T-6: the canonical-ref shape is documented in the shared block.
    expect(out).toContain('<namespace>/<memex>/<doc-type>/<doc-handle>');
  });

  it('lists acceptance criteria with their checkbox state', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask());
    expect(out).toContain('- [ ] Verifier hits real DB user');
    expect(out).toContain('- [x] Timing-safe compare in place');
  });

  it('separates resolved and open decisions, and flags task-blocking ones', () => {
    const resolved = makeDecision({
      id: 'dec-resolved',
      seq: 1,
      title: 'Pick a hash function',
      status: 'resolved',
      resolution: 'scrypt — Node built-in, no extra deps.',
    });
    const open = makeDecision({
      id: 'dec-open',
      seq: 2,
      title: 'Migrate existing password hashes?',
      status: 'open',
    });
    const blockingOpen = makeDecision({
      id: 'dec-blocking',
      seq: 3,
      title: 'Salt-handling for legacy rows',
      status: 'open',
    });

    const out = renderTaskInitPrompt(
      makeDoc({ decisions: [resolved, open, blockingOpen] }),
      makeTask({
        blocked: true,
        blockedByDecisions: [blockingOpen],
      }),
    );

    expect(out).toContain('Resolved');
    expect(out).toContain('`D-1` Pick a hash function → scrypt');
    expect(out).toContain('Open');
    expect(out).toContain('`D-2` Migrate existing password hashes?');
    expect(out).toContain('`D-3` Salt-handling for legacy rows — **blocks this task**');
    // And the task header notes it is blocked
    expect(out).toContain('Blocked by:');
  });

  it('summarises open task comments grouped by type, dropping resolved ones', () => {
    const planRev: Comment = {
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
    } as Comment;
    const resolved: Comment = {
      id: 'c2',
      sectionId: null,
      decisionId: null,
      taskId: 'task-uuid',
      authorName: 'Reviewer',
      content: 'Old comment that has been addressed',
      resolution: 'fixed',
      resolvedAt: '2026-05-03T00:00:00Z',
      createdAt: '2026-05-02T00:00:00Z',
      commentType: 'discussion',
    } as Comment;

    const out = renderTaskInitPrompt(makeDoc(), makeTask(), [planRev, resolved]);

    expect(out).toContain('Open comments on this task');
    expect(out).toContain('plan_revision (1)');
    expect(out).toContain('Add a test for the empty-input case');
    expect(out).not.toContain('Old comment that has been addressed');
  });

  it('omits the comments section entirely when there are no open comments', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask(), []);
    expect(out).not.toContain('Open comments on this task');
  });

  it('tells the agent to read the doc, review decisions, and apply review comments before starting', () => {
    const out = renderTaskInitPrompt(makeDoc(), makeTask());
    expect(out).toContain('How to start');
    // T-6: get_doc takes a canonical ref. The doc is a spec (handle `spec-1`) →
    // path segment `specs`. The user's `<namespace>/<memex>` is left as a
    // placeholder for the agent to substitute.
    expect(out).toContain('get_doc("<memex>/specs/spec-1")');
    // Review decisions
    expect(out).toMatch(/resolved decisions/i);
    expect(out).toMatch(/open decisions/i);
    // T-6: list_comments + update_task take a single `ref` argument (the canonical
    // task path), not a `taskId` UUID.
    expect(out).toContain('list_comments("<memex>/specs/spec-1/tasks/t-7")');
    expect(out).toContain('update_task("<memex>/specs/spec-1/tasks/t-7", { status: "in_progress" })');
    expect(out).toContain('update_task("<memex>/specs/spec-1/tasks/t-7", { status: "complete" })');
    // T-6: the task UUID should NOT appear anywhere — the canonical ref uses
    // the human-readable handle.
    expect(out).not.toContain('task-uuid');
  });
});
