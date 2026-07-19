import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { DriftInbox } from './DriftInbox';
import { DocumentShell } from '../components/DocumentShell';
import type { DriftInboxItem } from '../api/client';

// spec-143 dec-2: two explicit Drift Inbox row types.
const AC_TWO_ROW_TYPES =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-8';
const AC_NORMALIZED_PROPOSAL =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-9';
const AC_SCOPE_RENDER =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-2';
// spec-143 dec-3: no row buttons; clicking a row focuses the agent via a chip.
const AC_CLICK_FOCUS =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-10';
const AC_SCOPE_NO_BUTTONS =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-4';

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const mockAddContextChip = vi.fn();
const mockSendMessage = vi.fn();
const mockEnterDriftMode = vi.fn();
const mockExitDriftMode = vi.fn();
// spec-143 t-4 (dec-6) / spec-389 (dec-1): the inbox mounts the
// OpeningDriftController, which reads these drift-mode methods off useChat — stub
// them so the page renders without a real ChatProvider. The agent now opens with a
// static intro (no opening LLM turn), so there is no startDriftOpeningTurn.
vi.mock('../components/ChatContext', () => ({
  useChat: () => ({
    addContextChip: mockAddContextChip,
    sendMessage: mockSendMessage,
    enterDriftMode: mockEnterDriftMode,
    exitDriftMode: mockExitDriftMode,
    isDriftMode: true,
  }),
}));

// spec-143 t-3: the Drift Inbox now mounts inside DocumentShell — the same
// two-pane shell as the Spec page (ChatPanel beside the content). Mock the
// ChatPanel to a sentinel and stub DocumentShell's auth/access deps so the
// shell renders without a real session; we only assert the panel mounts
// alongside the inbox, not the agent internals (reused as-is per spec-143 t-3).
vi.mock('../components/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel">agent</div>,
}));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true }),
}));

const fetchDriftInboxMock = vi.fn();
const resolveCommentMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDriftInbox: (...args: unknown[]) => fetchDriftInboxMock(...args),
  resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
}));

function driftItem(overrides: Partial<DriftInboxItem> = {}): DriftInboxItem {
  return {
    commentId: 'c-1',
    commentHandle: 'c-1',
    commentType: 'drift',
    source: 'agent',
    authorName: 'Agent',
    content: 'Repo no longer does X.',
    proposedContent: null,
    createdAt: '2025-01-01T00:00:00Z',
    decision: {
      handle: 'dec-4',
      title: 'Domain auto-join requires explicit consent',
      specHandle: 'spec-9',
    },
    section: { id: 's-1', sectionType: 'do', title: null, content: 'Always X.' },
    doc: {
      id: 'd-1',
      handle: 'std-100',
      title: 'Caching standard',
      docType: 'standard',
      status: 'build',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DriftInbox', () => {
  it('links every row to a Standard (/standards/:handle) — drift is standards-only (b-63)', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([driftItem()]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const handleLink = await screen.findByText('std-100');
    expect(handleLink).toHaveAttribute('href', '/standards/std-100');
    // No filter chip without ?doc, and the API is called unfiltered.
    expect(screen.queryByTestId('drift-filter-chip')).not.toBeInTheDocument();
    expect(fetchDriftInboxMock).toHaveBeenCalledWith(undefined);
  });

  it('passes ?doc=std-N to the API and shows a clearable filter chip (b-63)', async () => {
    fetchDriftInboxMock.mockResolvedValue([driftItem()]);

    render(
      <MemoryRouter initialEntries={['/drift?doc=std-100']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    // 'std-100' appears both in the chip and the row handle link, so query the
    // chip by testid rather than by ambiguous text.
    const chip = await screen.findByTestId('drift-filter-chip');
    expect(chip).toHaveTextContent('std-100');
    expect(fetchDriftInboxMock).toHaveBeenCalledWith({ doc: 'std-100' });
  });

});

// Regression: a no-standards / no-drift workspace (e.g. a personal Memex) must
// resolve `loading` and land on a clear non-spinner state — never hang on the
// "Loading..." spinner. Covers both the empty-success path and the rejected-
// fetch fallback.
describe('DriftInbox — loading always resolves to a non-spinner state', () => {
  it('an empty inbox resolves loading and shows the empty state (no perpetual spinner)', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    // The empty state appears…
    expect(await screen.findByTestId('drift-empty-state')).toBeInTheDocument();
    // …and the spinner is gone (loading resolved).
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.getByText('No open drift or proposals.')).toBeInTheDocument();
  });

  it('a rejected fetch resolves loading and shows a non-spinner error state (not an infinite spinner, not the "all clear" empty state)', async () => {
    fetchDriftInboxMock.mockRejectedValueOnce(new Error('Request failed: 500'));

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    // The error surfaces…
    expect(await screen.findByText('Request failed: 500')).toBeInTheDocument();
    // …the spinner is gone (loading resolved)…
    await waitFor(() =>
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument(),
    );
    // …and we do NOT also show the misleading "all clear" empty state on a failure.
    expect(screen.queryByTestId('drift-empty-state')).not.toBeInTheDocument();
  });
});

describe('DriftInbox — no row buttons, click focuses the agent (spec-143 dec-3)', () => {
  it('renders NO Accept/Reject/Resolve buttons on any row (ac-10 first clause, ac-4)', async () => {
    tagAc(AC_CLICK_FOCUS);
    tagAc(AC_SCOPE_NO_BUTTONS);
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({ commentId: 'obs-1', commentType: 'drift', proposedContent: null }),
      driftItem({
        commentId: 'prop-1',
        commentType: 'plan_revision',
        content: 'Reword.\n~~~proposed-content\nCheck Y AND Z.\n~~~',
        proposedContent: 'Check Y AND Z.',
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    // Wait for rows to render, then assert the removed action cluster is gone.
    await screen.findAllByTestId('drift-inbox-row');
    expect(screen.queryByTestId('drift-accept')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drift-reject')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /accept|reject|resolve/i }),
    ).not.toBeInTheDocument();
  });

  it('clicking a drift row adds a drift_item context chip focusing the agent — same affordance as a section click (ac-10 second clause, ac-4)', async () => {
    tagAc(AC_CLICK_FOCUS);
    tagAc(AC_SCOPE_NO_BUTTONS);
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'obs-7',
        commentHandle: 'c-7',
        commentType: 'drift',
        proposedContent: null,
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    await user.click(row);

    expect(mockAddContextChip).toHaveBeenCalledTimes(1);
    // spec-143 i-2: the label carries the item number the user sees on the row
    // badge ("Drift #7") — the agent's drift context maps #N to c-N.
    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'drift_item',
      id: 'obs-7',
      label: 'Drift #7 on std-100 — Caching standard',
    });
    // Minimal payload — exactly three keys, mirroring the section/issue chips.
    expect(Object.keys(mockAddContextChip.mock.calls[0][0]).sort()).toEqual([
      'id',
      'label',
      'type',
    ]);
  });

  it('a proposal row chip labels itself "Proposal on …" (ac-10 second clause)', async () => {
    tagAc(AC_CLICK_FOCUS);
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'prop-9',
        commentHandle: 'c-9',
        commentType: 'plan_revision',
        content: 'Reword.\n~~~proposed-content\nNew text.\n~~~',
        proposedContent: 'New text.',
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    await user.click(row);

    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'drift_item',
      id: 'prop-9',
      label: 'Proposal #9 on std-100 — Caching standard',
    });
  });

  it('clicking the standard handle link does NOT also focus the agent (stopPropagation)', async () => {
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({ commentId: 'obs-3', commentType: 'drift', proposedContent: null }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const handleLink = await screen.findByText('std-100');
    await user.click(handleLink);
    expect(mockAddContextChip).not.toHaveBeenCalled();
  });
});

describe('DriftInbox — two explicit row types, drift-card style (spec-143 dec-2 / spec-498)', () => {
  it('a drift row reads as a relationship (dec ✗ contradicts std) and does NOT dump the comment body (ac-8)', async () => {
    tagAc(AC_TWO_ROW_TYPES);
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'obs-1',
        commentType: 'drift',
        content: 'The full drift finding body that must NOT appear in the list.',
        proposedContent: null,
        decision: {
          handle: 'dec-2',
          title: 'Domain auto-join requires explicit consent',
          specHandle: 'spec-9',
        },
        doc: {
          id: 'd-9',
          handle: 'std-10',
          title: 'Secrets never live in the repo',
          docType: 'standard',
          status: 'build',
        },
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    expect(row).toHaveAttribute('data-row-type', 'observation');
    // decision ✗ contradicts standard — the important information at a glance.
    expect(row.querySelector('[data-testid="drift-decision"]')!.textContent).toContain('dec-2');
    expect(row.querySelector('[data-testid="drift-decision"]')!.textContent).toContain(
      'Domain auto-join requires explicit consent',
    );
    expect(row.querySelector('[data-testid="drift-contradicts"]')!.textContent).toContain(
      'contradicts',
    );
    expect(row.querySelector('[data-testid="drift-standard"]')!.textContent).toContain('std-10');
    expect(row.querySelector('[data-testid="drift-standard"]')!.textContent).toContain(
      'Secrets never live in the repo',
    );
    // The heavy comment body is NOT dumped into the list row.
    expect(row.textContent).not.toContain('must NOT appear in the list');
    // No before/after diff on any row now.
    expect(document.querySelector('[data-testid="drift-proposal-diff"]')).toBeNull();
  });

  it('a decision-less (legacy) drift degrades to the standard + a clamped finding, no full body', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'legacy-1',
        commentType: 'drift',
        content: 'A legacy finding with no linked decision.',
        proposedContent: null,
        decision: null,
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    // No decision row, but the standard it's on still renders…
    expect(row.querySelector('[data-testid="drift-decision"]')).toBeNull();
    expect(row.querySelector('[data-testid="drift-standard"]')).not.toBeNull();
    // …and the finding shows (clamped), so the row isn't information-free.
    expect(row.textContent).toContain('A legacy finding with no linked decision.');
  });

  it('a proposal row is a one-liner ("Proposes a change to std-N …") — the heavy diff is gone (ac-9)', async () => {
    tagAc(AC_NORMALIZED_PROPOSAL);
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'prop-1',
        commentType: 'plan_revision',
        content: 'Reword.\n~~~proposed-content\nAlways cache with Redis.\n~~~',
        proposedContent: 'Always cache with Redis.',
        section: { id: 's-9', sectionType: 'do', title: null, content: 'Always cache.' },
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    expect(row).toHaveAttribute('data-row-type', 'proposal');
    const summary = row.querySelector('[data-testid="drift-proposal-summary"]')!;
    expect(summary.textContent).toContain('Proposes a change to');
    expect(summary.textContent).toContain('std-100');
    // The before/after diff and the proposed text are NOT in the list row.
    expect(row.querySelector('[data-testid="drift-proposal-diff"]')).toBeNull();
    expect(row.textContent).not.toContain('Always cache with Redis.');
    expect(row.textContent).not.toContain('Always cache.');
  });

  it('every row renders via exactly one of the two row types — drift observation vs proposal summary (ac-2)', async () => {
    tagAc(AC_SCOPE_RENDER);
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({ commentId: 'a', commentType: 'drift', proposedContent: null }),
      driftItem({
        commentId: 'b',
        commentType: 'plan_revision',
        content: 'fenced.\n~~~proposed-content\nNew text.\n~~~',
        proposedContent: 'New text.',
      }),
      driftItem({
        commentId: 'c',
        commentType: 'plan_revision',
        content: 'unfenced raw proposal',
        proposedContent: 'unfenced raw proposal',
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const rows = await screen.findAllByTestId('drift-inbox-row');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const rowType = row.getAttribute('data-row-type');
      expect(['observation', 'proposal']).toContain(rowType);
      const hasSummary =
        row.querySelector('[data-testid="drift-proposal-summary"]') !== null;
      const hasObservation =
        row.querySelector('[data-testid="drift-observation-body"]') !== null;
      // Exactly one rendering path — never both, never neither (the blob).
      expect(hasSummary).toBe(rowType === 'proposal');
      expect(hasObservation).toBe(rowType === 'observation');
      expect(hasSummary !== hasObservation).toBe(true);
      // The heavy diff is gone from the list entirely.
      expect(row.querySelector('[data-testid="drift-proposal-diff"]')).toBeNull();
    }
  });
});

// spec-143 i-2: drift items are referenceable by handle, with an explicit
// "Discuss with Agent" affordance — no more discussing items "by position".
describe('DriftInbox — c-N refs + Discuss with Agent (spec-143 i-2)', () => {
  it('every row badge carries its item number (#N — the c-N seq without the jargon prefix)', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({ commentId: 'u-1', commentHandle: 'c-2', commentType: 'drift', proposedContent: null }),
      driftItem({
        commentId: 'u-2',
        commentHandle: 'c-3',
        commentType: 'plan_revision',
        content: 'unfenced proposal',
        proposedContent: 'unfenced proposal',
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const handles = await screen.findAllByTestId('drift-comment-handle');
    expect(handles.map((h) => h.textContent)).toEqual(['#2', '#3']);
    // The number lives INSIDE the type badge — "Drift #2" / "Proposed change #3".
    expect(handles[0].parentElement).toHaveTextContent('Drift #2');
    expect(handles[1].parentElement).toHaveTextContent('Proposed change #3');
  });

  it('the "Discuss with Agent" button focuses the agent AND kicks off the resolution conversation', async () => {
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'u-9',
        commentHandle: 'c-4',
        commentType: 'drift',
        proposedContent: null,
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const button = await screen.findByTestId('drift-discuss-button');
    expect(button).toHaveTextContent('Discuss with Agent');
    await user.click(button);

    // stopPropagation: the button click must not ALSO bubble to the row's
    // onClick — exactly one chip.
    expect(mockAddContextChip).toHaveBeenCalledTimes(1);
    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'drift_item',
      id: 'u-9',
      label: 'Drift #4 on std-100 — Caching standard',
    });
    // The opening message carries the item reference in its TEXT (the chip only
    // decorates messages from the next send onwards) and asks the agent to
    // drive resolution.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sent = mockSendMessage.mock.calls[0][0] as string;
    expect(sent).toContain('Drift #4 on std-100');
    expect(sent).toMatch(/help me resolve/i);
  });

  it('a proposal row\'s Discuss kickoff asks for an accept/reject read, not the drift options', async () => {
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'u-10',
        commentHandle: 'c-5',
        commentType: 'plan_revision',
        content: 'unfenced proposal',
        proposedContent: 'unfenced proposal',
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const button = await screen.findByTestId('drift-discuss-button');
    await user.click(button);

    const sent = mockSendMessage.mock.calls[0][0] as string;
    expect(sent).toContain('Proposal #5 on std-100');
    expect(sent).toMatch(/accepted/i);
  });

  it('a plain row click only focuses — it does NOT send a message', async () => {
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({ commentId: 'u-11', commentHandle: 'c-6', commentType: 'drift', proposedContent: null }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('drift-inbox-row');
    await user.click(row);

    expect(mockAddContextChip).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// spec-498: the dec-N / std-N handles in a drift row are clickable, tenant-correct
// links to those items (dec → the spec's decision URL, std → the standard).
describe('DriftInbox — handle links (dec-N → spec decision, std-N → standard)', () => {
  it('renders dec-N as a tenant-correct link to /specs/:spec/decisions/:dec and std-N to /standards/:std', async () => {
    // tenantPath reads the tenant from window.location — set a tenant so the
    // links carry the /:ns/:mx prefix (the router renders the absolute href).
    window.history.pushState({}, '', '/acme/team/drift');
    try {
      fetchDriftInboxMock.mockResolvedValueOnce([
        driftItem({
          commentId: 'obs-link',
          commentType: 'drift',
          decision: { handle: 'dec-2', title: 'Consent decision', specHandle: 'spec-9' },
          doc: {
            id: 'd-1',
            handle: 'std-100',
            title: 'Caching standard',
            docType: 'standard',
            status: 'build',
          },
        }),
      ]);

      render(
        <MemoryRouter initialEntries={['/acme/team/drift']}>
          <DriftInbox />
        </MemoryRouter>,
      );

      const decLink = await screen.findByText('dec-2');
      expect(decLink.tagName).toBe('A');
      expect(decLink).toHaveAttribute('href', '/acme/team/specs/spec-9/decisions/dec-2');

      const stdLink = screen.getByText('std-100');
      expect(stdLink.tagName).toBe('A');
      expect(stdLink).toHaveAttribute('href', '/acme/team/standards/std-100');
    } finally {
      // Restore default location so later tests see no tenant (unprefixed links).
      window.history.pushState({}, '', '/');
    }
  });

  it('the dec-N handle degrades to plain text (no anchor) when the decision has no owning spec', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'obs-nospec',
        commentType: 'drift',
        decision: { handle: 'dec-7', title: 'Orphan decision', specHandle: null },
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const dec = await screen.findByText('dec-7');
    // Plain text, not an anchor — no valid decision URL without a spec.
    expect(dec.tagName).not.toBe('A');
    expect(screen.queryByTestId('drift-decision-link')).not.toBeInTheDocument();
  });

  it('clicking the dec-N link does NOT also focus the agent (stopPropagation)', async () => {
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      driftItem({
        commentId: 'obs-stop',
        commentType: 'drift',
        decision: { handle: 'dec-3', title: 'A decision', specHandle: 'spec-1' },
      }),
    ]);

    render(
      <MemoryRouter initialEntries={['/drift']}>
        <DriftInbox />
      </MemoryRouter>,
    );

    const decLink = await screen.findByTestId('drift-decision-link');
    await user.click(decLink);
    expect(mockAddContextChip).not.toHaveBeenCalled();
  });
});

// spec-498: `?drift=<commentId>` deep-links the inbox to a SPECIFIC drift item —
// the Brain knowledge graph's drift edge / drift card links here so the click-through
// lands on the exact item, not just the doc-filtered list. It scrolls the matching
// row into view and gives it a transient highlight.
describe('DriftInbox — deep-link to a specific drift (?drift=<commentId>)', () => {
  it('scrolls the matching row into view and highlights it; other rows are not highlighted', async () => {
    const scrollSpy = vi.fn();
    // jsdom does not implement Element.scrollIntoView — stub it, restore after.
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      fetchDriftInboxMock.mockResolvedValue([
        driftItem({ commentId: 'drift-c-41', commentHandle: 'c-41' }),
        driftItem({ commentId: 'drift-c-42', commentHandle: 'c-42' }),
      ]);

      render(
        <MemoryRouter initialEntries={['/drift?doc=std-100&drift=drift-c-42']}>
          <DriftInbox />
        </MemoryRouter>,
      );

      await screen.findAllByTestId('drift-inbox-row');

      // The targeted row gets the transient highlight…
      await waitFor(() => {
        const target = document.querySelector('[data-comment-id="drift-c-42"]');
        expect(target).toHaveAttribute('data-highlighted', 'true');
      });
      // …and it was scrolled into view.
      expect(scrollSpy).toHaveBeenCalled();
      // The non-targeted row is left alone.
      const other = document.querySelector('[data-comment-id="drift-c-41"]');
      expect(other).not.toHaveAttribute('data-highlighted');
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
    }
  });

  it('does nothing (no highlight) when the drift id matches no row — never crashes', async () => {
    const scrollSpy = vi.fn();
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      fetchDriftInboxMock.mockResolvedValue([
        driftItem({ commentId: 'drift-c-41', commentHandle: 'c-41' }),
      ]);

      render(
        <MemoryRouter initialEntries={['/drift?drift=does-not-exist']}>
          <DriftInbox />
        </MemoryRouter>,
      );

      await screen.findAllByTestId('drift-inbox-row');
      // No row is highlighted and no scroll happened.
      expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
    }
  });
});

// spec-143 t-3: the Drift Inbox mounts in the same two-pane DocumentShell as the
// Spec page (App.tsx `specs/:id` → <DocumentShell><DocDocument/></DocumentShell>)
// — the agent ChatPanel beside the drift list — so the click-to-focus drift_item
// chip has a panel to land in. These tests assert the panel region renders
// alongside the inbox (chip behaviour is covered by the rendered-direct tests
// above; DocumentShell only relays the existing ChatProvider).
describe('DriftInbox — agent panel mounts beside the inbox (spec-143 t-3)', () => {
  function renderInShell(initialEntries = ['/drift']) {
    return render(
      <MemoryRouter initialEntries={initialEntries}>
        <DocumentShell>
          <DriftInbox />
        </DocumentShell>
      </MemoryRouter>,
    );
  }

  it('renders the agent ChatPanel alongside the drift list (populated inbox)', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([driftItem()]);

    renderInShell();

    // The drift list still renders inside the content pane…
    expect(await screen.findByTestId('drift-inbox-row')).toBeInTheDocument();
    // …and the agent panel renders beside it (the two-pane Spec-page layout).
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });

  it('renders the agent ChatPanel alongside the empty state (no drift)', async () => {
    fetchDriftInboxMock.mockResolvedValueOnce([]);

    renderInShell();

    // The empty state still renders correctly within the new content pane…
    expect(await screen.findByTestId('drift-empty-state')).toBeInTheDocument();
    // …and the agent panel is still mounted beside it.
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });
});
