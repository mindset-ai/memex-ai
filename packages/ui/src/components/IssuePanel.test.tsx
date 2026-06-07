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

  it('focus-to-chat fires from the hover icon with a minimal {type:issue, id, label} ContextChip', async () => {
    // c-1 (ratified) as amended by spec-164 dec-4: the minimal chip — id + a
    // `issue-N — title` label, nothing richer (the agent fetches via
    // get_issue) — now fires ONLY from the dedicated hover icon; the card
    // click itself toggles the inline expansion instead.
    // spec-158 ac-16: the chip label uses the issue-N handle form.
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-16');
    const user = userEvent.setup();
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'iss-7', seq: 7, title: 'Token leak in logs' }),
    ]);

    render(<IssuePanel docId="doc-1" />);

    await screen.findByTestId('issue-card');
    await user.click(screen.getByTestId('issue-focus'));

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

// spec-164 dec-4 — inline expand/collapse accordion on issue cards.
describe('IssuePanel — inline expansion (spec-164)', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  it('clicking a card expands it in place (full body + metadata); clicking again collapses; several can be open', async () => {
    tagAc(AC164(19));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-4');
    const user = userEvent.setup();
    const longBody = 'line one\nline two\nline three — long enough to be clamped when collapsed.';
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'iss-1', seq: 1, title: 'First', body: longBody }),
      makeIssue({ id: 'iss-2', seq: 2, title: 'Second', body: 'short body' }),
    ]);

    render(<IssuePanel docId="doc-1" />);
    const cards = await screen.findAllByTestId('issue-card');
    expect(cards).toHaveLength(2);
    expect(screen.queryByTestId('issue-expanded')).not.toBeInTheDocument();

    await user.click(cards[0]);
    expect(cards[0]).toHaveAttribute('aria-expanded', 'true');
    const expanded = screen.getByTestId('issue-expanded');
    expect(expanded).toHaveTextContent('line three — long enough to be clamped when collapsed.');
    expect(expanded).toHaveTextContent('issue-1');

    // Second card opens alongside the first.
    await user.click(cards[1]);
    expect(screen.getAllByTestId('issue-expanded')).toHaveLength(2);

    // Clicking the first again collapses only it.
    await user.click(cards[0]);
    expect(cards[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId('issue-expanded')).toHaveLength(1);
  });

  it('a plain card click does NOT add the issue to the chat context', async () => {
    tagAc(AC164(20));
    const user = userEvent.setup();
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-1', seq: 1 })]);

    render(<IssuePanel docId="doc-1" />);
    await user.click(await screen.findByTestId('issue-card'));

    expect(mockAddContextChip).not.toHaveBeenCalled();
  });

  it('a deep-linked issue lands scrolled, highlighted AND expanded', async () => {
    tagAc(AC164(21));
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'iss-5', seq: 5, title: 'Deep target', body: 'full detail' }),
    ]);

    render(<IssuePanel docId="doc-1" highlightIssueHandle="issue-5" />);
    const card = await screen.findByTestId('issue-card');
    await waitFor(() => expect(card).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByTestId('issue-expanded')).toHaveTextContent('full detail');
  });
});

// spec-182 dec-4 — issue powers split by posture: register stays canWrite,
// dispositions (Convert to Task / Won't fix) move to canEdit.
describe('IssuePanel — posture-split powers (spec-182)', () => {
  const AC182_12 = 'mindset-prod/memex-building-itself/specs/spec-182/acs/ac-12';
  const AC182_4 = 'mindset-prod/memex-building-itself/specs/spec-182/acs/ac-4';

  it('a writable reviewer (canWrite, no canEdit) can register but sees no dispositions', async () => {
    tagAc(AC182_12);
    tagAc(AC182_4);
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-1', seq: 1, status: 'open' })]);

    render(<IssuePanel docId="doc-1" canWrite canEdit={false} />);
    await screen.findByTestId('issue-card');

    // Register stays available…
    expect(screen.getByTestId('issue-add')).toBeInTheDocument();
    // …the dispositions do not (spec-188: Resolve + the ⋯ menu carrying
    // Won't fix are dispositions too, so they gate identically).
    expect(screen.queryByTestId('issue-convert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('issue-wontfix')).not.toBeInTheDocument();
  });

  it('an editor (canEdit) keeps all dispositions on an open issue', async () => {
    tagAc(AC182_12);
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-1', seq: 1, status: 'open' })]);

    const user = userEvent.setup();
    render(<IssuePanel docId="doc-1" canWrite canEdit />);
    await screen.findByTestId('issue-card');

    expect(screen.getByTestId('issue-convert')).toBeInTheDocument();
    expect(screen.getByTestId('issue-resolve')).toBeInTheDocument();
    // spec-188 dec-3: Won't fix lives in the ⋯ menu beside Resolve.
    await user.click(screen.getByTestId('issue-menu'));
    expect(screen.getByTestId('issue-wontfix')).toBeInTheDocument();
  });
});

// spec-188 — issue-resolution progress bar (ac-2), per-row Resolve (ac-3 /
// ac-11), "resolved" vocabulary (ac-4) and the muted type tags on non-open
// issues (ac-5).
describe('IssuePanel — resolution progress + resolve controls (spec-188)', () => {
  const SPEC188 = 'mindset-prod/memex-building-itself/specs/spec-188';

  it('renders the resolution Metric beneath the heading and above the list', async () => {
    tagAc(`${SPEC188}/acs/ac-2`);
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'i-1', seq: 1, status: 'resolved' }),
      makeIssue({ id: 'i-2', seq: 2, status: 'open' }),
      makeIssue({ id: 'i-3', seq: 3, status: 'open' }),
      makeIssue({ id: 'i-4', seq: 4, status: 'wont_fix' }),
    ]);

    render(<IssuePanel docId="doc-1" />);
    const header = await screen.findByTestId('issue-resolution-header');

    // 2 of 4 non-open → 50%, with the same Metric visual identity as the AC
    // panel (big tabular % + the h-2 rounded bar from MetricBar).
    expect(within(header).getByText('50%')).toBeInTheDocument();
    expect(within(header).getByText('resolved')).toBeInTheDocument();
    expect(within(header).getByTestId('metric-bar-resolved')).toBeInTheDocument();
    expect(within(header).getByText('2 of 4 issues resolved')).toBeInTheDocument();

    // Position: beneath the heading block, above the issue list — the header
    // precedes the first issue card in document order.
    const firstCard = screen.getAllByTestId('issue-card')[0];
    expect(
      header.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('no progress bar on an empty issue list', async () => {
    tagAc(`${SPEC188}/acs/ac-2`);
    mockFetchIssues.mockResolvedValue([]);

    render(<IssuePanel docId="doc-1" />);
    await screen.findByTestId('issue-panel');
    expect(screen.queryByTestId('issue-resolution-header')).not.toBeInTheDocument();
  });

  it('the heading says "resolved" — the word "closed" is gone from the panel', async () => {
    tagAc(`${SPEC188}/acs/ac-4`);
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'i-1', seq: 1, status: 'open' }),
      makeIssue({ id: 'i-2', seq: 2, status: 'resolved' }),
      makeIssue({ id: 'i-3', seq: 3, status: 'wont_fix' }),
      makeIssue({ id: 'i-4', seq: 4, status: 'converted' }),
    ]);

    render(<IssuePanel docId="doc-1" />);
    const panel = await screen.findByTestId('issue-panel');
    expect(within(panel).getByText('1 open, 3 resolved')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/closed/i);
  });

  it('Resolve on the row marks the issue resolved and the panel updates in place', async () => {
    tagAc(`${SPEC188}/acs/ac-3`);
    tagAc(`${SPEC188}/acs/ac-11`);
    const issue = makeIssue({ id: 'iss-9', seq: 9, status: 'open' });
    mockFetchIssues.mockResolvedValue([issue]);
    mockUpdateIssueStatusApi.mockImplementation(async () => {
      // Subsequent loads see the resolved row — the regroup + counts assert
      // the refetch happened without a page reload.
      mockFetchIssues.mockResolvedValue([{ ...issue, status: 'resolved' }]);
      return { ...issue, status: 'resolved' };
    });

    const user = userEvent.setup();
    render(<IssuePanel docId="doc-1" />);
    await user.click(await screen.findByTestId('issue-resolve'));

    expect(mockUpdateIssueStatusApi).toHaveBeenCalledWith('iss-9', 'resolved');
    await waitFor(() =>
      expect(screen.getByText('0 open, 1 resolved')).toBeInTheDocument(),
    );
    // The resolved row regrouped out of open: its controls are gone…
    expect(screen.queryByTestId('issue-resolve')).not.toBeInTheDocument();
    // …and the bar reflects 100%.
    expect(
      within(screen.getByTestId('issue-resolution-header')).getByText('100%'),
    ).toBeInTheDocument();
  });

  it("Won't fix in the row menu transitions via the same status mutation", async () => {
    tagAc(`${SPEC188}/acs/ac-11`);
    const issue = makeIssue({ id: 'iss-7', seq: 7, status: 'open' });
    mockFetchIssues.mockResolvedValue([issue]);
    mockUpdateIssueStatusApi.mockResolvedValue({ ...issue, status: 'wont_fix' });

    const user = userEvent.setup();
    render(<IssuePanel docId="doc-1" />);
    await user.click(await screen.findByTestId('issue-menu'));
    await user.click(screen.getByTestId('issue-wontfix'));

    expect(mockUpdateIssueStatusApi).toHaveBeenCalledWith('iss-7', 'wont_fix');
  });

  it('bug/todo type tags go neutral grey once the issue is no longer open', async () => {
    tagAc(`${SPEC188}/acs/ac-5`);
    mockFetchIssues.mockResolvedValue([
      makeIssue({ id: 'i-1', seq: 1, type: 'bug', status: 'open' }),
      makeIssue({ id: 'i-2', seq: 2, type: 'bug', status: 'resolved' }),
      makeIssue({ id: 'i-3', seq: 3, type: 'todo', status: 'resolved' }),
    ]);

    render(<IssuePanel docId="doc-1" />);
    await screen.findByTestId('issue-panel');

    const cards = screen.getAllByTestId('issue-card');
    const byStatus = (status: string, type: string) =>
      cards.find(
        (c) =>
          c.getAttribute('data-issue-status') === status &&
          c.getAttribute('data-issue-type') === type,
      )!;

    // Open bug keeps the pronounced danger badge…
    const openBugBadge = within(byStatus('open', 'bug')).getByText('bug');
    // …a resolved bug's type tag drops to the same neutral classes the todo
    // tag wears. We assert by comparing class lists: resolved bug === todo
    // (neutral), and !== open bug (danger).
    const resolvedBugBadge = within(byStatus('resolved', 'bug')).getByText('bug');
    const resolvedTodoBadge = within(byStatus('resolved', 'todo')).getByText('todo');
    expect(resolvedBugBadge.className).toBe(resolvedTodoBadge.className);
    expect(resolvedBugBadge.className).not.toBe(openBugBadge.className);
  });
});

// spec-188 dec-4 (ac-13) — Convert-to-Task is suppressed where the human is in
// the verify posture: allowConvert=false drops the Convert control while the
// other dispositions stay.
describe('IssuePanel — allowConvert gating (spec-188 dec-4)', () => {
  const AC13 = 'mindset-prod/memex-building-itself/specs/spec-188/acs/ac-13';

  it('allowConvert=false hides Convert but keeps Resolve and the won\'t-fix menu', async () => {
    tagAc(AC13);
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-1', seq: 1, status: 'open' })]);

    const user = userEvent.setup();
    render(<IssuePanel docId="doc-1" canWrite canEdit allowConvert={false} />);
    await screen.findByTestId('issue-card');

    expect(screen.queryByTestId('issue-convert')).not.toBeInTheDocument();
    expect(screen.getByTestId('issue-resolve')).toBeInTheDocument();
    await user.click(screen.getByTestId('issue-menu'));
    expect(screen.getByTestId('issue-wontfix')).toBeInTheDocument();
  });

  it('default (allowConvert omitted) keeps Convert — the Build-tab posture', async () => {
    tagAc(AC13);
    mockFetchIssues.mockResolvedValue([makeIssue({ id: 'iss-1', seq: 1, status: 'open' })]);

    render(<IssuePanel docId="doc-1" canWrite canEdit />);
    await screen.findByTestId('issue-card');

    expect(screen.getByTestId('issue-convert')).toBeInTheDocument();
  });
});
