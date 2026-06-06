import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { TaskPanel } from './TaskPanel';
import type { Task } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

const mockAddContextChip = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: mockAddContextChip }),
}));

vi.mock('../api/client', () => ({
  // spec-159 ac-18: tasks are read-only in the UI. The panel no longer imports
  // createTaskApi / updateTaskStatusApi — those mutations live with the coding
  // agent over MCP. fetchPlanReadiness is the only client call TaskPanel makes,
  // for the plan-trigger badge; mock to a no-op array.
  fetchPlanReadiness: vi.fn().mockResolvedValue([]),
}));

vi.mock('./ExecutionPlanModal', () => ({
  ExecutionPlanModal: () => <div data-testid="execution-plan-modal-stub" />,
  derivePlanBadgeState: () => 'submitted',
  planStateLabel: () => 'Submitted',
  PLAN_STATE_CLASSES: {
    none: '',
    submitted: '',
    ready: '',
    not_ready: '',
    approved: '',
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `t-${Math.random().toString(36).slice(2, 6)}`,
    docId: 'doc-1',
    seq: 1,
    title: 'Write tests',
    description: 'Cover the happy path',
    status: 'not_started',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    sectionRef: null,
    acceptanceCriteria: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

beforeEach(() => vi.clearAllMocks());

describe('TaskPanel', () => {
  it('renders one card per task with correct status data attribute', () => {
    const tasks = [
      makeTask({ id: 'a', seq: 1, status: 'not_started' }),
      makeTask({ id: 'b', seq: 2, status: 'in_progress' }),
      makeTask({ id: 'c', seq: 3, status: 'complete' }),
      makeTask({ id: 'd', seq: 4, status: 'not_started', blocked: true, blockedByDecisions: [{ id: 'x', seq: 1 } as any] }),
    ];
    render(<TaskPanel docId="doc-1" tasks={tasks} onUpdate={vi.fn()} />);

    const cards = screen.getAllByTestId('task-card');
    expect(cards).toHaveLength(4);

    const byStatus = Object.fromEntries(
      cards.map((c) => [c.getAttribute('data-task-seq'), c.getAttribute('data-task-status')])
    );
    expect(byStatus['T-1']).toBe('not_started');
    expect(byStatus['T-2']).toBe('in_progress');
    expect(byStatus['T-3']).toBe('complete');
    expect(byStatus['T-4']).toBe('blocked');
  });

  it('counts each status bucket in the header', () => {
    const tasks = [
      makeTask({ seq: 1, status: 'not_started' }),
      makeTask({ seq: 2, status: 'not_started' }),
      makeTask({ seq: 3, status: 'in_progress' }),
      makeTask({ seq: 4, status: 'complete' }),
      makeTask({ seq: 5, status: 'not_started', blocked: true }),
    ];
    render(<TaskPanel docId="doc-1" tasks={tasks} onUpdate={vi.fn()} />);
    expect(
      screen.getByText('2 ready, 1 blocked, 1 in progress, 1 complete')
    ).toBeInTheDocument();
  });

  // ── spec-159 ac-18: tasks are read-only in the UI ──
  // Tasks are created and driven exclusively by coding agents through the MCP
  // tools, so the panel renders no status mutation (start/complete/reset) and
  // no "Add task" affordance — for tasks in *every* status, member or not.

  it('renders no status-mutation control for a not_started task (ac-18)', () => {
    tagAc(AC(18));
    const task = makeTask({ id: 'task-1', seq: 7, status: 'not_started' });
    render(<TaskPanel docId="doc-1" tasks={[task]} onUpdate={vi.fn()} />);
    expect(screen.queryByTestId('task-start')).not.toBeInTheDocument();
  });

  it('renders no status-mutation control for an in_progress task (ac-18)', () => {
    tagAc(AC(18));
    const task = makeTask({ id: 'task-2', seq: 8, status: 'in_progress' });
    render(<TaskPanel docId="doc-1" tasks={[task]} onUpdate={vi.fn()} />);
    expect(screen.queryByTestId('task-complete')).not.toBeInTheDocument();
  });

  it('renders no status-mutation control for a complete task (ac-18)', () => {
    tagAc(AC(18));
    const task = makeTask({ id: 'task-3', seq: 9, status: 'complete' });
    render(<TaskPanel docId="doc-1" tasks={[task]} onUpdate={vi.fn()} />);
    expect(screen.queryByTestId('task-reset')).not.toBeInTheDocument();
  });

  it('renders no "Add task" affordance — empty or populated (ac-18)', () => {
    tagAc(AC(18));
    const { rerender } = render(<TaskPanel docId="doc-1" tasks={[]} onUpdate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Add task/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Task title/i)).not.toBeInTheDocument();

    rerender(<TaskPanel docId="doc-1" tasks={[makeTask({ id: 't', seq: 1 })]} onUpdate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Add task/i })).not.toBeInTheDocument();
  });

  it('exposes no task mutation even with canWrite — no start/complete/reset/add/kick (ac-18)', () => {
    tagAc(AC(18));
    const tasks = [
      makeTask({ id: 'a', seq: 1, status: 'not_started' }),
      makeTask({ id: 'b', seq: 2, status: 'in_progress' }),
      makeTask({ id: 'c', seq: 3, status: 'complete' }),
    ];
    render(<TaskPanel docId="doc-1" doc={{ id: 'doc-1' } as any} tasks={tasks} onUpdate={vi.fn()} canWrite />);

    // No mutation affordances on any task, in any status.
    expect(screen.queryByTestId('task-start')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-reset')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add task/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/kick|to issue/i)).not.toBeInTheDocument();
  });

  it('renders acceptance criteria with checked vs. unchecked states', () => {
    const task = makeTask({
      seq: 1,
      acceptanceCriteria: [
        { description: 'Unit tests pass', done: false },
        { description: 'Typecheck clean', done: true },
      ] as any,
    });
    render(<TaskPanel docId="doc-1" tasks={[task]} onUpdate={vi.fn()} />);
    expect(screen.getByText('Unit tests pass')).toBeInTheDocument();
    expect(screen.getByText('Typecheck clean')).toBeInTheDocument();
    expect(screen.getByText('[x]')).toBeInTheDocument();
    expect(screen.getByText('[ ]')).toBeInTheDocument();
  });

  // ── spec-164 issue: task cards are read-only agent artifacts ──
  // Tasks are managed by the coding agent only (created/driven through MCP);
  // humans read. The per-task Prompt and comment affordances are gone — human
  // feedback on a task flows through the page-level Comments view / chat. This
  // SUPERSEDES the TaskPanel-side behaviour of spec-164 dec-6 (the tray-mount
  // aspect of ac-24/ac-25): task cards no longer mount a CommentTray at all.
  // The CommentTray muteAgentChatter filter itself survives for other trays and
  // stays verified at the component level (see CommentTray.test.tsx).
  describe('agent-tasks read-only surface (spec-164 issue)', () => {
    const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

    it('renders the panel header as "Agent Tasks"', () => {
      render(<TaskPanel docId="doc-1" tasks={[makeTask({ id: 't', seq: 1 })]} onUpdate={vi.fn()} />);
      expect(screen.getByRole('heading', { name: 'Agent Tasks' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Tasks' })).not.toBeInTheDocument();
    });

    it('a task card renders NO comments toggle and NO Prompt button, even where comment data used to drive them', () => {
      tagAc(AC164(24));
      tagAc(AC164(25));
      const task = makeTask({ id: 't-1', seq: 1 });
      // `doc` + comment-shaped data are passed the way the old card consumed
      // them; the read-only surface ignores both — no affordances appear.
      render(
        <TaskPanel
          docId="doc-1"
          doc={{ id: 'doc-1' } as any}
          tasks={[task]}
          onUpdate={vi.fn()}
          canWrite
        />,
      );
      expect(screen.queryByTestId('task-prompt')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Show comments')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Hide comments')).not.toBeInTheDocument();
      expect(screen.queryByTestId('comment-tray-stub')).not.toBeInTheDocument();
    });

    it('still renders status badges and acceptance criteria (read stays intact)', () => {
      const task = makeTask({
        id: 't-2',
        seq: 3,
        status: 'in_progress',
        acceptanceCriteria: [
          { description: 'AC one', done: false },
          { description: 'AC two', done: true },
        ] as any,
      });
      render(<TaskPanel docId="doc-1" tasks={[task]} onUpdate={vi.fn()} />);
      const card = screen.getByTestId('task-card');
      expect(card.getAttribute('data-task-status')).toBe('in_progress');
      expect(screen.getByText('in progress')).toBeInTheDocument();
      expect(screen.getByText('AC one')).toBeInTheDocument();
      expect(screen.getByText('AC two')).toBeInTheDocument();
      expect(screen.getByText('[ ]')).toBeInTheDocument();
      expect(screen.getByText('[x]')).toBeInTheDocument();
    });
  });

  // ── spec-164 dec-2: the t-19 List/Graph toggle is REMOVED — build is
  //    list-only. These pin the removal (ac-15).
  describe('graph view removed (spec-164)', () => {
    const AC_REMOVED = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-15';

    it('renders the task list unconditionally with no view toggle', () => {
      tagAc(AC_REMOVED);
      tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-8');
      const tasks = [makeTask({ id: 't', seq: 1 })];
      render(<TaskPanel docId="doc-1" tasks={tasks} onUpdate={vi.fn()} />);
      expect(screen.getByTestId('task-card')).toBeInTheDocument();
      expect(screen.queryByTestId('task-view-toggle')).not.toBeInTheDocument();
      expect(screen.queryByTestId('task-view-graph')).not.toBeInTheDocument();
    });

    it('ignores any stale persisted graph preference from the removed toggle', () => {
      tagAc(AC_REMOVED);
      try {
        localStorage.setItem('taskpanel-view:doc-1', 'graph');
      } catch {
        /* jsdom without localStorage */
      }
      const tasks = [makeTask({ id: 't', seq: 1 })];
      render(<TaskPanel docId="doc-1" tasks={tasks} onUpdate={vi.fn()} />);
      expect(screen.getByTestId('task-card')).toBeInTheDocument();
    });
  });
});
// spec-188 dec-5 (ac-14) — the Build tab's task-completion Metric: same
// MetricBar identity as the AC/issues bars, beneath the heading, above the
// list, hidden at zero tasks.
describe('TaskPanel — completion metric (spec-188)', () => {
  const AC14 = 'mindset-prod/memex-building-itself/specs/spec-188/acs/ac-14';

  it('renders the completion Metric with the shared bar identity', () => {
    tagAc(AC14);
    const tasks = [
      makeTask({ id: 'a', seq: 1, status: 'complete' }),
      makeTask({ id: 'b', seq: 2, status: 'complete' }),
      makeTask({ id: 'c', seq: 3, status: 'in_progress' }),
      makeTask({ id: 'd', seq: 4, status: 'not_started' }),
    ];
    render(<TaskPanel docId="doc-1" tasks={tasks} onUpdate={vi.fn()} />);

    const header = screen.getByTestId('task-completion-header');
    expect(header).toBeInTheDocument();
    // 2 of 4 complete → 50%, rendered by the shared Metric tile.
    expect(header.textContent).toContain('50%');
    expect(header.textContent).toContain('2 of 4 tasks complete');
    expect(screen.getByTestId('metric-bar-complete')).toBeInTheDocument();
    // Position: the metric precedes the first task card in document order.
    const firstCard = screen.getAllByTestId('task-card')[0];
    expect(
      header.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is hidden when the Spec has zero tasks', () => {
    tagAc(AC14);
    render(<TaskPanel docId="doc-1" tasks={[]} onUpdate={vi.fn()} />);
    expect(screen.queryByTestId('task-completion-header')).not.toBeInTheDocument();
  });
});
