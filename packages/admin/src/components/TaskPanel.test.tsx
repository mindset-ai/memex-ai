import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

vi.mock('./CommentTray', () => ({
  CommentTray: ({ targetId }: { targetId: string }) => (
    <div data-testid="comment-tray-stub" data-target-id={targetId} />
  ),
}));

vi.mock('./PromptModal', () => ({
  PromptModal: () => <div data-testid="prompt-modal" />,
}));

// Stub TaskGraph so the toggle tests don't pull reactflow into jsdom (it
// expects DOM measurement APIs that jsdom doesn't fully implement).
vi.mock('./TaskGraph', () => ({
  TaskGraph: ({ tasks }: { tasks: { id: string }[] }) => (
    <div data-testid="task-graph-stub" data-task-count={tasks.length} />
  ),
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

  it('exposes no task mutation even with canWrite — only the read-only Prompt and comments remain (ac-18)', () => {
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

    // Read-only handoff survives: the Prompt button (copying a prompt is not a
    // mutation) is rendered per task.
    expect(screen.getAllByTestId('task-prompt').length).toBe(tasks.length);
    // Comments survive too — they're not a task mutation, so the comment
    // affordance rides every task card even though start/complete/reset are gone
    // (ac-18). Opening one mounts the CommentTray.
    const commentToggles = screen.getAllByTitle('Show comments');
    expect(commentToggles.length).toBe(tasks.length);
    fireEvent.click(commentToggles[0]);
    expect(screen.getByTestId('comment-tray-stub')).toBeInTheDocument();
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

  // ── List/Graph toggle (t-19 W4) ──

  describe('view toggle (List | Graph)', () => {
    beforeEach(() => {
      try {
        localStorage.clear();
      } catch {
        /* jsdom may not have localStorage in some envs */
      }
    });

    it('defaults to list view when nothing is persisted', () => {
      const tasks = [makeTask({ id: 't', seq: 1 })];
      render(<TaskPanel docId="default-doc" tasks={tasks} onUpdate={vi.fn()} />);
      expect(screen.getByTestId('task-view-list')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('task-view-graph')).toHaveAttribute('data-active', 'false');
      expect(screen.queryByTestId('task-graph-stub')).not.toBeInTheDocument();
      expect(screen.getByTestId('task-card')).toBeInTheDocument();
    });

    it('switching to graph hides the list and renders the graph', async () => {
      const user = userEvent.setup();
      const tasks = [makeTask({ id: 't', seq: 1 })];
      render(<TaskPanel docId="switch-doc" tasks={tasks} onUpdate={vi.fn()} />);

      await user.click(screen.getByTestId('task-view-graph'));
      expect(screen.getByTestId('task-view-graph')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('task-graph-stub')).toBeInTheDocument();
      expect(screen.queryByTestId('task-card')).not.toBeInTheDocument();
    });

    it('persists the chosen view to localStorage keyed by docId', async () => {
      const user = userEvent.setup();
      const tasks = [makeTask({ id: 't', seq: 1 })];
      const { unmount } = render(
        <TaskPanel docId="persist-doc" tasks={tasks} onUpdate={vi.fn()} />,
      );
      await user.click(screen.getByTestId('task-view-graph'));
      expect(localStorage.getItem('taskpanel-view:persist-doc')).toBe('graph');

      unmount();

      // Re-render — defaults read from localStorage.
      render(<TaskPanel docId="persist-doc" tasks={tasks} onUpdate={vi.fn()} />);
      expect(screen.getByTestId('task-view-graph')).toHaveAttribute('data-active', 'true');
    });

    it('persistence is per-spec (different docIds get independent defaults)', async () => {
      const user = userEvent.setup();
      const tasks = [makeTask({ id: 't', seq: 1 })];

      const { unmount } = render(
        <TaskPanel docId="spec-A" tasks={tasks} onUpdate={vi.fn()} />,
      );
      await user.click(screen.getByTestId('task-view-graph'));
      unmount();

      // spec-B has nothing persisted → defaults to list.
      render(<TaskPanel docId="spec-B" tasks={tasks} onUpdate={vi.fn()} />);
      expect(screen.getByTestId('task-view-list')).toHaveAttribute('data-active', 'true');
    });
  });
});
