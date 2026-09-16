// spec-566 t-9 (ac-10) — the human half: a supersession proposal is reviewable
// in the Drift Inbox, beside the standards proposals, without a new surface.
//
//   ac-10  "A pending supersession appears in the Drift Inbox (/drift) alongside
//          standards proposals, rendering both the original and the proposed
//          statement, and the page's copy no longer scopes itself to Standards
//          alone. The row carries the agent handoff affordance rather than
//          instructing an MCP call [per std-34]."
//
// Four claims, four groups below. The server half — that the row reaches the
// page at all — is in services/drift-inbox-ac-supersession.integration.test.ts;
// none of these would catch a read path that returned nothing, because they all
// feed the page a fixture.
//
// NO ACCEPT BUTTON, asserted rather than assumed. spec-143 dec-3 removed the
// per-row Accept / Reject / Resolve controls deliberately — deciding whether a
// rule should change is a judgement, not a one-click yes/no — and dec-1 leans on
// that same indirection for its retry-resistance: the human accepts by talking
// to the agent, behind `render_confirmation`, so the agent cannot issue the
// confirmation for itself. A button added here later would quietly undo that.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { DriftInbox } from './DriftInbox';
import type { DriftInboxItem } from '../api/client';

const AC_10 = 'mindset-prod/memex-building-itself/specs/spec-566/acs/ac-10';

const ORIGINAL = 'The exporter writes one row per invoice.';
const REPLACEMENT = 'The exporter writes one row per invoice LINE ITEM.';

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

function supersessionItem(overrides: Partial<DriftInboxItem> = {}): DriftInboxItem {
  return {
    commentId: 'sup-1',
    commentHandle: 'c-3',
    commentType: 'plan_revision',
    source: 'agent',
    authorName: 'Agent',
    content: 'raw comment body with the supersession payload',
    proposedContent: 'raw comment body with the supersession payload',
    proposal: {
      kind: 'ac-supersession',
      before: ORIGINAL,
      after: REPLACEMENT,
      current: ORIGINAL,
    },
    ac: { handle: 'ac-7', kind: 'implementation', statement: ORIGINAL },
    createdAt: '2026-09-16T00:00:00Z',
    decision: null,
    section: null,
    doc: {
      id: 'd-9',
      handle: 'spec-42',
      title: 'The exporter reconciles to the ledger',
      docType: 'spec',
      status: 'build',
    },
    ...overrides,
  };
}

/** A standards proposal, so "alongside" is a claim this file can actually make. */
function standardsItem(): DriftInboxItem {
  return {
    commentId: 'prop-1',
    commentHandle: 'c-5',
    commentType: 'plan_revision',
    source: 'agent',
    authorName: 'Agent',
    content: 'clause ops payload',
    proposedContent: 'clause ops payload',
    proposal: {
      kind: 'clause-ops',
      operations: [
        { op: 'edit', clause: 'cl-12', before: 'a', after: 'b', current: 'a' },
      ],
    },
    createdAt: '2026-09-15T00:00:00Z',
    decision: null,
    section: { id: 's-1', sectionType: 'do', title: null, content: 'a' },
    doc: { id: 'd-1', handle: 'std-100', title: 'Caching standard', docType: 'standard', status: 'build' },
  };
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/drift']}>
      <DriftInbox />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('ac-10 — the supersession is reviewable in the same queue', () => {
  it('renders BOTH the original and the proposed statement, on demand', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    const user = userEvent.setup();
    renderInbox();

    // Collapsed to start, and collapsed means NOT RENDERED — spec-498 took the
    // wall of text out of this list deliberately, and a supersession must not
    // put it back.
    await screen.findByTestId('drift-inbox-row');
    expect(screen.queryByTestId('drift-ac-supersession-diff')).toBeNull();

    await user.click(screen.getByTestId('drift-ac-supersession-toggle'));

    // ac-10's actual claim. One without the other is an unreviewable proposal:
    // "here is the new text" with nothing to compare it against.
    expect(screen.getByTestId('drift-ac-before')).toHaveTextContent(ORIGINAL);
    expect(screen.getByTestId('drift-ac-after')).toHaveTextContent(REPLACEMENT);
  });

  it('names the CRITERION, not just the Spec', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    renderInbox();

    // "Proposes a change to spec-42" would leave the reviewer hunting for which
    // of its criteria is under proposal.
    expect(await screen.findByTestId('drift-ac-handle')).toHaveTextContent('ac-7');
    expect(screen.getByTestId('drift-proposal-summary')).toHaveTextContent('spec-42');
  });

  it('appears ALONGSIDE a standards proposal, not instead of one', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([standardsItem(), supersessionItem()]);
    renderInbox();

    const rows = await screen.findAllByTestId('drift-inbox-row');
    expect(rows).toHaveLength(2);
    // Both kinds render their own disclosure — the standards one keeps the
    // clause diff it has had since spec-530, and neither has swallowed the other.
    expect(screen.getByTestId('drift-proposal-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('drift-ac-supersession-toggle')).toBeInTheDocument();
  });

  it('warns when the criterion moved under the proposal, and stays quiet when it did not', async () => {
    tagAc(AC_10);
    const user = userEvent.setup();

    // Quiet case first — the vacuity guard. If the warning rendered
    // unconditionally, the positive case below would pass on nothing.
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    const { unmount } = renderInbox();
    await screen.findByTestId('drift-inbox-row');
    await user.click(screen.getByTestId('drift-ac-supersession-toggle'));
    expect(screen.queryByTestId('drift-ac-moved')).toBeNull();
    unmount();

    fetchDriftInboxMock.mockResolvedValueOnce([
      supersessionItem({
        proposal: {
          kind: 'ac-supersession',
          before: ORIGINAL,
          after: REPLACEMENT,
          current: 'The exporter writes one row per invoice, net of credits.',
        },
      }),
    ]);
    renderInbox();
    await screen.findByTestId('drift-inbox-row');
    await user.click(screen.getByTestId('drift-ac-supersession-toggle'));

    // The accept REFUSES in this state (t-2). Seeing it here is the difference
    // between a reviewer who understands the refusal and one who meets it cold.
    expect(screen.getByTestId('drift-ac-moved')).toHaveTextContent('net of credits');
  });

  it('renders a retirement with no successor as a retirement, not as unreadable', async () => {
    tagAc(AC_10);
    const user = userEvent.setup();
    fetchDriftInboxMock.mockResolvedValueOnce([
      supersessionItem({
        proposal: { kind: 'ac-supersession', before: ORIGINAL, after: null, current: ORIGINAL },
      }),
    ]);
    renderInbox();

    await screen.findByTestId('drift-inbox-row');
    await user.click(screen.getByTestId('drift-ac-supersession-toggle'));

    expect(screen.getByTestId('drift-ac-after')).toHaveTextContent(
      'Retire this criterion with no replacement',
    );
    // NOT the "carries no readable changes" line, which would tell the reviewer
    // the payload was corrupt when it is a well-formed, deliberate proposal.
    expect(screen.queryByTestId('drift-proposal-unapplicable')).toBeNull();
  });
});

describe('ac-10 — the page stops claiming to be Standards-only', () => {
  it('widens the subtitle to name acceptance criteria', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    renderInbox();

    await screen.findByTestId('drift-inbox-row');
    // "criteria", the plural of criterion. And this copy ships WITH the verb —
    // a page advertising a capability the product lacks is the defect spec-530
    // is named after.
    expect(screen.getByText(/acceptance criteria/i)).toBeInTheDocument();
  });

  it('widens the empty state too', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([]);
    renderInbox();

    // The empty state is what a reader sees most often, and "No open drift or
    // proposals" on a page that now also holds criterion supersessions reads as
    // a page that cannot show them.
    expect(await screen.findByText(/criterion supersessions/i)).toBeInTheDocument();
  });
});

describe('ac-10 — the handoff, and no Accept button [std-34, spec-143 dec-3]', () => {
  it('offers the agent handoff and instructs no MCP call', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    renderInbox();

    const row = await screen.findByTestId('drift-inbox-row');
    // The affordance names the ACTION, and it is a control the reader can use
    // rather than an instruction they cannot follow [std-34].
    expect(screen.getByTestId('drift-discuss-button')).toHaveTextContent('Discuss with Agent');

    // No MCP tool name anywhere on the row. std-34's rationale is explicit: a
    // human told to call `accept_ac_supersession` reads an instruction they
    // cannot follow and concludes the product is broken.
    expect(row.textContent ?? '').not.toMatch(/accept_ac_supersession|propose_ac_supersession|get_information/);
  });

  it('carries no inline Accept / Reject / Resolve control', async () => {
    tagAc(AC_10);
    fetchDriftInboxMock.mockResolvedValueOnce([supersessionItem()]);
    const user = userEvent.setup();
    renderInbox();

    await screen.findByTestId('drift-inbox-row');
    await user.click(screen.getByTestId('drift-ac-supersession-toggle'));

    // Expanded, because a control hidden behind the disclosure would pass a
    // collapsed-only check. dec-1's retry-resistance depends on the human
    // accepting THROUGH the agent, behind render_confirmation.
    for (const label of [/^accept$/i, /^reject$/i, /^resolve$/i, /^apply$/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });
});
