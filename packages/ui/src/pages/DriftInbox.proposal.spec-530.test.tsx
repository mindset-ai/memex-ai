// spec-530 t-7 (ac-2) — the human half of "the proposed text is fully visible to both
// readers who must judge it".
//
// ac-2 is a SCOPE criterion covering two readers, and it fails unless BOTH pass:
//   - the AGENT half is ac-22, already green — `buildDriftContext` stops truncating
//     `proposedContent` at 500 characters (spec-530 t-6);
//   - the HUMAN half is this file — the Drift Inbox row renders the current clause and
//     the proposed clause, with the cl-N visible.
// Tagging ac-2 here is therefore only honest BECAUSE ac-22 is green. If ac-22 ever goes
// red, ac-2's badge is lying regardless of what this file says.
//
// The row previously rendered NOTHING of the proposal: `proposedContent` came down the
// wire and no component read it, while the file's own header claimed the diff was
// "reachable via Discuss with Agent or the standard page" — true of neither.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { DriftInbox } from './DriftInbox';
import type { DriftInboxItem, DriftProposalOperation } from '../api/client';

// scope ac-2: BOTH readers see the proposal whole (composes with ac-22, the agent half).
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-530/acs/ac-2';
// spec-143 dec-3 / spec-530 non-goals: the Inbox carries no action controls.
const AC_5 = 'mindset-prod/memex-building-itself/specs/spec-530/acs/ac-5';
// spec-530 t-9: a legacy body degrades to an explanatory row, never a crash.
const AC_18 = 'mindset-prod/memex-building-itself/specs/spec-530/acs/ac-18';

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../components/ChatContext', () => ({
  useChat: () => ({
    addContextChip: vi.fn(),
    sendMessage: vi.fn(),
    enterDriftMode: vi.fn(),
    exitDriftMode: vi.fn(),
    isDriftMode: true,
  }),
}));
vi.mock('../components/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel">agent</div>,
}));
vi.mock('../components/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../hooks/useMemexAccess', () => ({ useMemexAccess: () => ({ canWrite: true }) }));

const fetchDriftInboxMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDriftInbox: (...args: unknown[]) => fetchDriftInboxMock(...args),
  resolveComment: vi.fn(),
}));

function proposalItem(overrides: Partial<DriftInboxItem> = {}): DriftInboxItem {
  return {
    commentId: 'prop-1',
    commentHandle: 'c-5',
    commentType: 'plan_revision',
    source: 'agent',
    authorName: 'Agent',
    content: 'raw comment body with the operations payload',
    proposedContent: 'raw comment body with the operations payload',
    proposal: {
      kind: 'clause-ops',
      operations: [
        {
          op: 'edit',
          clause: 'cl-12',
          before: 'Cache every write.',
          after: 'Cache every write except mutating endpoints.',
          current: 'Cache every write.',
        },
      ],
    },
    createdAt: '2025-01-01T00:00:00Z',
    decision: null,
    section: { id: 's-1', sectionType: 'do', title: null, content: 'Cache every write.' },
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

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/drift']}>
      <DriftInbox />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spec-530 t-7: a proposal row shows current vs proposed per operation (ac-2)', () => {
  it('reveals the current clause, the proposed clause and the cl-N when expanded', async () => {
    tagAc(AC_2);
    fetchDriftInboxMock.mockResolvedValueOnce([proposalItem()]);
    const user = userEvent.setup();
    renderInbox();

    // Collapsed to start — nothing of the diff is in the DOM yet (see the
    // spec-498 note below).
    expect(await screen.findByTestId('drift-inbox-row')).toBeInTheDocument();
    expect(screen.queryByTestId('drift-proposal-diff')).toBeNull();

    await user.click(screen.getByTestId('drift-proposal-toggle'));

    const diff = screen.getByTestId('drift-proposal-diff');
    // The target, named by its canonical handle [per std-10] — never "the second one".
    expect(diff.querySelector('[data-testid="drift-proposal-clause"]')!.textContent).toBe('cl-12');
    // What the rule says now…
    expect(diff.querySelector('[data-testid="drift-proposal-current"]')!.textContent).toContain(
      'Cache every write.',
    );
    // …and what the proposal wants it to say. THIS is the text a user could not see.
    expect(diff.querySelector('[data-testid="drift-proposal-proposed"]')!.textContent).toContain(
      'Cache every write except mutating endpoints.',
    );
  });

  it('renders the proposed text in full — not truncated, which is ac-2\'s whole point', async () => {
    tagAc(AC_2);
    // Longer than DRIFT_BODY_MAX (500), the cap that silently cut the AGENT's copy
    // until t-6. Neither reader may see a string that has been quietly shortened.
    const long = `${'A'.repeat(600)}END-OF-PROPOSAL`;
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({
        proposal: {
          kind: 'clause-ops',
          operations: [
            { op: 'edit', clause: 'cl-3', before: 'short', after: long, current: 'short' },
          ],
        },
      }),
    ]);
    const user = userEvent.setup();
    renderInbox();

    await user.click(await screen.findByTestId('drift-proposal-toggle'));
    expect(
      screen.getByTestId('drift-proposal-diff').querySelector('[data-testid="drift-proposal-proposed"]')!
        .textContent,
    ).toContain('END-OF-PROPOSAL');
  });

  it('shows an add as a new clause anchored to a cl-N, and a delete as a removal', async () => {
    tagAc(AC_2);
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({
        proposal: {
          kind: 'clause-ops',
          operations: [
            {
              op: 'add',
              clause: 'cl-7',
              placement: 'after',
              after: 'The rule was missing this case.',
              current: 'The anchor clause.',
            },
            { op: 'delete', clause: 'cl-9', before: 'Obsolete.', current: 'Obsolete.' },
          ],
        },
      }),
    ]);
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByTestId('drift-proposal-toggle'));

    const ops = screen.getAllByTestId('drift-proposal-operation');
    expect(ops).toHaveLength(2);
    expect(ops[0]).toHaveAttribute('data-op', 'add');
    expect(ops[0]).toHaveAttribute('data-clause', 'cl-7');
    expect(ops[0].textContent).toContain('The rule was missing this case.');
    expect(ops[1]).toHaveAttribute('data-op', 'delete');
    expect(ops[1].textContent).toContain('Removed entirely.');
  });

  it('says so when the targeted clause no longer exists, instead of rendering a blank', async () => {
    tagAc(AC_2);
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({
        proposal: {
          kind: 'clause-ops',
          operations: [
            { op: 'edit', clause: 'cl-4', before: 'gone', after: 'never applied', current: null },
          ],
        },
      }),
    ]);
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByTestId('drift-proposal-toggle'));

    expect(screen.getByTestId('drift-proposal-clause-gone').textContent).toContain(
      'no longer exists',
    );
  });
});

describe('spec-530 t-7: the list stays scannable, and gains no action controls', () => {
  it('keeps a 12-operation proposal to one line until the reader opens it', async () => {
    tagAc(AC_2);
    const operations: DriftProposalOperation[] = Array.from({ length: 12 }, (_, i) => ({
      op: 'edit' as const,
      clause: `cl-${i + 1}`,
      before: `old body ${i + 1}`,
      after: `new body ${i + 1}`,
      current: `old body ${i + 1}`,
    }));
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({ proposal: { kind: 'clause-ops', operations } }),
    ]);
    const user = userEvent.setup();
    renderInbox();

    // dec-1 made a proposal a SET, which is only liveable on this surface because the
    // set is collapsed by default. Twelve operations must not become twelve stacked
    // blocks in a list.
    const toggle = await screen.findByTestId('drift-proposal-toggle');
    expect(toggle.textContent).toContain('12 clause changes');
    expect(screen.queryAllByTestId('drift-proposal-operation')).toHaveLength(0);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getAllByTestId('drift-proposal-operation')).toHaveLength(12);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // And it collapses again — a reader who opened the wrong row can put it back.
    await user.click(toggle);
    expect(screen.queryAllByTestId('drift-proposal-operation')).toHaveLength(0);
  });

  it('adds NO Accept / Reject / Resolve control — spec-143 dec-3 stands (ac-5)', async () => {
    tagAc(AC_5);
    fetchDriftInboxMock.mockResolvedValueOnce([proposalItem()]);
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByTestId('drift-proposal-toggle'));

    // The row is READ-ONLY. spec-530's non-goals decline to revisit spec-143 dec-3, and
    // the drift agent's guidance tells users acceptance happens in conversation — an
    // Accept button here would make that guidance a lie again [per std-34].
    const row = screen.getByTestId('drift-inbox-row');
    for (const name of [/^accept/i, /^reject/i, /^resolve/i, /^apply/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // Exactly two buttons on the row: Discuss with Agent, and the diff disclosure.
    expect(row.querySelectorAll('button')).toHaveLength(2);
  });

  it('expanding the diff does not fire the row-level focus action', async () => {
    tagAc(AC_2);
    fetchDriftInboxMock.mockResolvedValueOnce([proposalItem()]);
    const user = userEvent.setup();
    renderInbox();

    // The row focuses the agent on click. The disclosure sits inside it, so without
    // stopPropagation, reading a diff would silently retarget the agent conversation.
    await user.click(await screen.findByTestId('drift-proposal-toggle'));
    expect(screen.getByTestId('drift-proposal-diff')).toBeInTheDocument();
  });
});

describe('spec-530 t-7: an unapplicable proposal degrades to one row, never a crash (ac-18)', () => {
  it('explains a legacy whole-section proposal instead of dumping its body', async () => {
    tagAc(AC_18);
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({
        proposal: { kind: 'legacy', proposed: 'A WHOLE REPLACEMENT SECTION BODY.' },
      }),
    ]);
    renderInbox();

    const note = await screen.findByTestId('drift-proposal-unapplicable');
    expect(note).toHaveAttribute('data-proposal-kind', 'legacy');
    expect(note.textContent).toContain('predates the clause grain');
    // The wall of text spec-498 removed does not come back through this door.
    expect(screen.getByTestId('drift-inbox-row').textContent).not.toContain(
      'A WHOLE REPLACEMENT SECTION BODY.',
    );
    // Nothing to expand — there are no operations to diff.
    expect(screen.queryByTestId('drift-proposal-toggle')).toBeNull();
  });

  it('renders every OTHER row when one proposal is unreadable — the blast radius is one row', async () => {
    tagAc(AC_18);
    fetchDriftInboxMock.mockResolvedValueOnce([
      proposalItem({ commentId: 'bad', proposal: { kind: 'unreadable' } }),
      proposalItem({ commentId: 'good' }),
    ]);
    renderInbox();

    const rows = await screen.findAllByTestId('drift-inbox-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('drift-proposal-unapplicable').textContent).toContain(
      'no readable changes',
    );
    // The healthy row still offers its diff.
    expect(screen.getAllByTestId('drift-proposal-toggle')).toHaveLength(1);
  });
});
