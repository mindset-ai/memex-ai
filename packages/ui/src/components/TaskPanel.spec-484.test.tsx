// spec-484 t-3 / dec-2 — TaskPanel clamped previews render inline markdown
// without breaking the clamp.
//
//   • ac-8 / ac-13 — the task description and each acceptance-criterion line
//     route through the markdown renderer (inline mode): `code` → <code>,
//     `**bold**` → <strong>.
//   • ac-15        — the previews stay CLAMPED: the description keeps its
//     line-clamp-2 wrapper and no block list (<li>) leaks into the single line.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { TaskPanel } from './TaskPanel';
import type { Task } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn() }),
}));
vi.mock('../api/client', () => ({
  fetchPlanReadiness: vi.fn().mockResolvedValue([]),
}));
vi.mock('./ExecutionPlanModal', () => ({
  ExecutionPlanModal: () => <div data-testid="execution-plan-modal-stub" />,
  derivePlanBadgeState: () => 'submitted',
  planStateLabel: () => 'Submitted',
  PLAN_STATE_CLASSES: { none: '', submitted: '', ready: '', not_ready: '', approved: '' },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Write tests',
    description: 'Cover the `happy` **path**',
    status: 'not_started',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    sectionRef: null,
    acceptanceCriteria: [{ description: 'The `login` button is **disabled**', done: false }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

beforeEach(() => vi.clearAllMocks());

describe('spec-484: TaskPanel clamped previews render inline markdown', () => {
  it('ac-8 / ac-13 / ac-15: description + AC lines render inline markdown, clamp preserved, no block leak', () => {
    tagAc(AC(8));
    tagAc(AC(13));
    tagAc(AC(15));
    render(<TaskPanel docId="doc-1" tasks={[makeTask()]} onUpdate={vi.fn()} />);

    const card = screen.getByTestId('task-card');

    // The description preview keeps its clamp wrapper and renders inline markdown.
    const preview = card.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('code')?.textContent).toBe('happy');
    expect(preview!.querySelector('strong')?.textContent).toBe('path');
    // No block list leaks into the clamped single line.
    expect(preview!.querySelector('li')).toBeNull();
    expect(preview!.textContent).not.toContain('`happy`');

    // The acceptance-criterion line renders inline markdown too.
    expect(within(card).getByText('login').tagName).toBe('CODE');
    expect(card.querySelector('li')).toBeNull();
  });
});
