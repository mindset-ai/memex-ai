import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssuePanel } from './IssuePanel';
import type { Issue } from '../api/types';
import { tagAc } from "@memex-ai-ac/vitest";

const mockAddContextChip = vi.fn();
const mockFetchIssues = vi.fn();
const mockCreateIssueApi = vi.fn();
const mockUpdateIssueStatusApi = vi.fn();
const mockConvertIssueToTaskApi = vi.fn();

// Capture the SSE refetch callback so a test can simulate a live bus event.
let lastStreamCallback: (() => void) | null = null;

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: mockAddContextChip }),
}));

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: (_docId: string | null, onEvent: () => void) => {
    lastStreamCallback = onEvent;
  },
}));

vi.mock('../api/client', () => ({
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
  createIssueApi: (...args: unknown[]) => mockCreateIssueApi(...args),
  updateIssueStatusApi: (...args: unknown[]) => mockUpdateIssueStatusApi(...args),
  convertIssueToTaskApi: (...args: unknown[]) => mockConvertIssueToTaskApi(...args),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: `iss-${Math.random().toString(36).slice(2, 6)}`,
    docId: 'doc-1',
    seq: 1,
    title: 'Login button does nothing',
    body: 'Clicking login is a no-op on Safari.',
    type: 'bug',
    severity: null,
    status: 'open',
    source: 'human',
    satisfyingTaskId: null,
    promotedDocId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lastStreamCallback = null;
});

describe('IssuePanel', () => {
  it('is a first-class peer listing Issues by issue-N and stays live over SSE', async () => {
    // ac-2: Issues tab is a first-class peer addressable by issue-N, live over SSE.
    tagAc('mindset-prod/memex-building-itself/specs/spec-112/acs/ac-2');
    // spec-158 ac-16: the rendered handle + data-issue-seq selector are the
    // issue-N form (the i-N → issue-N UI cutover).
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-16');

    // First load returns one Issue; the simulated SSE refetch returns two.
    mockFetchIssues
      .mockResolvedValueOnce([makeIssue({ id: 'iss-1', seq: 1, title: 'First bug' })])
      .mockResolvedValueOnce([
        makeIssue({ id: 'iss-1', seq: 1, title: 'First bug' }),
        makeIssue({ id: 'iss-2', seq: 2, title: 'Second bug', type: 'todo' }),
      ]);

    render(<IssuePanel docId="doc-1" />);

    // Addressable by issue-N: the per-Spec handle renders on the card.
    const firstCard = await screen.findByTestId('issue-card');
    expect(within(firstCard).getByText('issue-1')).toBeInTheDocument();
    expect(firstCard).toHaveAttribute('data-issue-seq', 'issue-1');

    // The panel subscribed to the doc-change bus.
    expect(lastStreamCallback).not.toBeNull();

    // Simulate a live create event on the bus → the panel refetches and the
    // new Issue appears without any user action.
    lastStreamCallback!();
    await waitFor(() => {
      expect(screen.getAllByTestId('issue-card')).toHaveLength(2);
    });
    expect(screen.getByText('issue-2')).toBeInTheDocument();
  });

  it('lets a human register an Issue against the Spec as a whole, any phase, no anchor', async () => {
    // ac-1: a human can register an Issue against the Spec as a whole — no
    // anchor, any phase. The create call carries only docId + title + body +
    // type — no section/anchor parameter exists in the surface.
    tagAc('mindset-prod/memex-building-itself/specs/spec-112/acs/ac-1');

    const user = userEvent.setup();
    mockFetchIssues.mockResolvedValue([]);
    mockCreateIssueApi.mockResolvedValue(makeIssue({ id: 'iss-new', seq: 1 }));

    render(<IssuePanel docId="doc-1" />);

    await screen.findByTestId('issue-add');
    await user.click(screen.getByTestId('issue-add'));

    await user.type(screen.getByLabelText('Issue title'), 'Search returns 500');
    await user.type(screen.getByLabelText('Issue body'), 'POST /search 500s on empty query.');
    // Author it as a todo to prove the type toggle is wired.
    await user.click(screen.getByTestId('issue-type-todo'));

    await user.click(screen.getByRole('button', { name: 'Register issue' }));

    await waitFor(() => {
      expect(mockCreateIssueApi).toHaveBeenCalledTimes(1);
    });
    // docId, title, body, type — Spec-as-a-whole, NO anchor argument.
    expect(mockCreateIssueApi).toHaveBeenCalledWith(
      'doc-1',
      'Search returns 500',
      'POST /search 500s on empty query.',
      'todo',
    );
  });

  it('click-to-focus sets a minimal {type:issue, id, label} ContextChip', async () => {
    // c-1 (ratified): clicking an Issue row drops a minimal chip — id + a
    // `issue-N — title` label, nothing richer (the agent fetches via get_issue).
    // spec-158 ac-16: the chip label uses the issue-N handle form.
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-16');
    const user = userEvent.setup();
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'iss-7', seq: 7, title: 'Token leak in logs' }),
    ]);

    render(<IssuePanel docId="doc-1" />);

    const card = await screen.findByTestId('issue-card');
    await user.click(card);

    expect(mockAddContextChip).toHaveBeenCalledTimes(1);
    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'issue',
      id: 'iss-7',
      label: 'issue-7 — Token leak in logs',
    });
    // Minimal — exactly three keys, no body / severity / status smuggled in.
    expect(Object.keys(mockAddContextChip.mock.calls[0][0]).sort()).toEqual([
      'id',
      'label',
      'type',
    ]);
  });

  it('surfaces the Issue → Task down-bridge on an open Issue', async () => {
    const user = userEvent.setup();
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-9', seq: 9 })]);
    mockConvertIssueToTaskApi.mockResolvedValue({
      task: { id: 't1' },
      acId: 'ac1',
      issue: makeIssue({ id: 'iss-9', seq: 9, status: 'converted' }),
    });

    render(<IssuePanel docId="doc-1" />);

    await screen.findByTestId('issue-card');
    await user.click(screen.getByTestId('issue-convert'));

    await waitFor(() => {
      expect(mockConvertIssueToTaskApi).toHaveBeenCalledWith('iss-9');
    });
  });

  it('deep-links via an issue-N highlight handle, targeting the issue-N data-issue-seq card', async () => {
    // spec-158 ac-16: the `specs/:id/issues/:issueId` deep-link now carries an
    // `issue-N` handle. IssuePanel parses it (the /^issue-(\d+)$/ regex), finds
    // the matching card by its issue-N `data-issue-seq` selector, scrolls it
    // into view, and pulses the highlight ring. A bare `i-N` no longer matches.
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-16');
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-5');

    const scrollIntoView = vi.fn();
    // jsdom doesn't implement scrollIntoView; stub it so the highlight effect's
    // best-effort scroll is observable rather than throwing.
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'iss-4', seq: 4, title: 'Flaky retry' }),
    ]);

    const { rerender } = render(
      <IssuePanel docId="doc-1" highlightIssueHandle="issue-4" />,
    );

    const card = await screen.findByTestId('issue-card');
    // The card is DOM-targeted by its issue-N selector.
    expect(card).toHaveAttribute('data-issue-seq', 'issue-4');

    // The issue-N handle parsed → the matching card scrolled into view + got the
    // highlight ring (accent border class).
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
      expect(card.className).toContain('border-accent');
    });

    // A bare `i-N` no longer matches the post-cutover regex — no scroll, no ring.
    scrollIntoView.mockClear();
    rerender(<IssuePanel docId="doc-1" highlightIssueHandle="i-4" />);
    await waitFor(() => {
      expect(screen.getByTestId('issue-card')).toBeInTheDocument();
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('suppresses mutation controls when canWrite is false', async () => {
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-3', seq: 3 })]);

    render(<IssuePanel docId="doc-1" canWrite={false} />);

    await screen.findByTestId('issue-card');
    expect(screen.queryByTestId('issue-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-convert')).not.toBeInTheDocument();
  });
});
