import { describe, it, expect } from 'vitest';
import { buildTaskGraphData } from './TaskGraph';
import type { Task, Decision } from '../api/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Implement auth',
    description: '',
    acceptanceCriteria: [],
    sectionRef: null,
    status: 'not_started',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: '2025-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-uuid-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Use REST or gRPC?',
    context: null,
    status: 'open',
    resolution: null,
    resolvedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    options: null,
    chosenOptionIndex: null,
    ...overrides,
  };
}

describe('buildTaskGraphData (TaskGraph mapping — t-19 W4)', () => {
  it('maps each task to a node, ordered by seq within its lane', () => {
    const tasks = [
      makeTask({ id: 'a', seq: 2, title: 'A' }),
      makeTask({ id: 'b', seq: 1, title: 'B' }),
    ];
    const { nodes } = buildTaskGraphData(tasks);
    const taskNodes = nodes.filter((n) => !n.id.startsWith('dec-'));
    expect(taskNodes).toHaveLength(2);
    const idsByY = [...taskNodes].sort((x, y) => x.position.y - y.position.y).map((n) => n.id);
    // Lower seq lands higher in the lane.
    expect(idsByY).toEqual(['b', 'a']);
  });

  it('places ready / in_progress / blocked tasks in distinct columns', () => {
    const ready = makeTask({ id: 'ready-1', seq: 1, title: 'R', status: 'not_started', blocked: false });
    const inProgress = makeTask({ id: 'ip-1', seq: 2, title: 'IP', status: 'in_progress' });
    const blocked = makeTask({
      id: 'blk-1',
      seq: 3,
      title: 'B',
      status: 'not_started',
      blocked: true,
      blockedByDecisions: [makeDecision({ id: 'dec-uuid', seq: 7, title: 'Pick one' })],
    });
    const { nodes } = buildTaskGraphData([ready, inProgress, blocked]);

    const node = (id: string) => nodes.find((n) => n.id === id)!;
    expect(node('ready-1').position.x).toBe(40);
    expect(node('ip-1').position.x).toBe(360);
    expect(node('blk-1').position.x).toBe(680);
  });

  it('renders task→task blocking edges', () => {
    const blocker = makeTask({ id: 'blocker', seq: 1 });
    const blocked = makeTask({
      id: 'blocked',
      seq: 2,
      blocked: true,
      blockedByTasks: [blocker],
    });
    const { edges } = buildTaskGraphData([blocker, blocked]);
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'blocker',
        target: 'blocked',
        data: { kind: 'task' },
      }),
    );
  });

  it('synthesises a decision node + dashed edge for task→decision blockers', () => {
    const blockingDec = makeDecision({ id: 'dec-uuid-7', seq: 7, title: 'Pick one' });
    const t = makeTask({
      id: 'tx',
      seq: 1,
      blocked: true,
      blockedByDecisions: [blockingDec],
    });
    const { nodes, edges } = buildTaskGraphData([t]);
    const decNode = nodes.find((n) => n.id === 'dec-dec-uuid-7');
    expect(decNode).toBeDefined();
    expect((decNode!.data as { label?: string }).label).toMatch(/D-7/);

    const edge = edges.find((e) => e.target === 'tx');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('dec-dec-uuid-7');
    expect((edge!.data as { kind: string }).kind).toBe('decision');
    expect(edge!.style?.strokeDasharray).toBeDefined();
  });

  it('drops cross-spec task edges (target task missing from this graph)', () => {
    const orphanBlocker = makeTask({ id: 'in-other-spec', seq: 99 });
    const t = makeTask({
      id: 'local',
      seq: 1,
      blocked: true,
      blockedByTasks: [orphanBlocker],
    });
    // Only `local` is in the input — `orphanBlocker` simulates a cross-spec ref.
    const { edges } = buildTaskGraphData([t]);
    expect(edges).toHaveLength(0);
  });

  it('marks tasks with linked execution plans (●) in the rendered label', () => {
    const t = makeTask({ id: 'with-plan', seq: 1, executionPlanDocId: 'plan-doc' });
    const { nodes } = buildTaskGraphData([t]);
    const node = nodes.find((n) => n.id === 'with-plan')!;
    const label = (node.data as { label?: string }).label ?? '';
    expect(label).toContain('●');
  });
});
