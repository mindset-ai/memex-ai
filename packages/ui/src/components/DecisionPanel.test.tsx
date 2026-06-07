import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DecisionPanel } from './DecisionPanel';
import type { Decision } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

const mockAddContextChip = vi.fn();
const mockSendMessage = vi.fn();
const mockCreateDecision = vi.fn();
const mockApproveDecisionApi = vi.fn();
const mockRejectDecisionApi = vi.fn();
const mockResolveDecisionApi = vi.fn();
const mockCreateDecisionComment = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({
    addContextChip: mockAddContextChip,
    sendMessage: mockSendMessage,
  }),
}));

// AuthContext is consumed for the comment authorName when "Flag for discussion"
// posts a question-typed comment on a candidate.
vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Tester McTest', email: 'tester@memex.ai' },
  }),
}));

vi.mock('../api/client', () => ({
  createDecision: (...args: unknown[]) => mockCreateDecision(...args),
  approveDecisionApi: (...args: unknown[]) => mockApproveDecisionApi(...args),
  rejectDecisionApi: (...args: unknown[]) => mockRejectDecisionApi(...args),
  resolveDecisionApi: (...args: unknown[]) => mockResolveDecisionApi(...args),
  createDecisionComment: (...args: unknown[]) => mockCreateDecisionComment(...args),
}));

vi.mock('./CommentTray', () => ({
  CommentTray: ({ targetId }: { targetId: string }) => (
    <div data-testid="comment-tray-stub" data-target-id={targetId} />
  ),
}));

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `dec-${Math.random().toString(36).slice(2, 6)}`,
    docId: 'doc-1',
    seq: 1,
    title: 'Which database?',
    context: '',
    status: 'open',
    resolution: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    options: null,
    chosenOptionIndex: null,
    ...overrides,
  } as Decision;
}

beforeEach(() => vi.clearAllMocks());

describe('DecisionPanel', () => {
  it('renders open + resolved decisions with the right status attributes', async () => {
    const user = userEvent.setup();
    const decisions = [
      makeDecision({ id: 'd-open', seq: 1, title: 'Which DB?', status: 'open' }),
      makeDecision({
        id: 'd-res',
        seq: 2,
        title: 'Auth approach?',
        status: 'resolved',
        resolution: 'Use HS256 JWT',
      }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
      />
    );

    // Default tab is 'open' when no candidates exist; the open card is visible.
    let cards = screen.getAllByTestId('decision-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-decision-status')).toBe('open');
    expect(cards[0].getAttribute('data-decision-seq')).toBe('D-1');

    // Switch to the Resolved tab and check the resolved card.
    await user.click(screen.getByRole('button', { name: /^Resolved/ }));
    cards = screen.getAllByTestId('decision-card');
    expect(cards).toHaveLength(1);
    const resolvedCard = cards[0];
    expect(resolvedCard.getAttribute('data-decision-status')).toBe('resolved');
    expect(resolvedCard.getAttribute('data-decision-seq')).toBe('D-2');
    // Resolution appears twice — once in the compact row, once in the expandable <details>.
    expect(within(resolvedCard).getAllByText('Use HS256 JWT').length).toBeGreaterThan(0);
  });

  it('a reviewer (canWrite true, canEdit false) sees the decision + its comment tray but no forward-driving controls (ac-9)', () => {
    tagAc(AC(9));
    // A single open decision so the panel defaults to the Open tab and the card
    // (plus its forward-driving Resolve control) is on screen for a reviewer.
    const decisions = [
      makeDecision({ id: 'd1', seq: 7, status: 'open', title: 'What stack?' }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
        canWrite={true}
        canEdit={false}
      />
    );

    // The Spec content is fully readable — the decision card is present…
    expect(screen.getByText('What stack?')).toBeInTheDocument();
    // …and the comment affordance (a tray) remains available to the reviewer
    // because comments gate on canWrite, not canEdit.
    expect(screen.getAllByTestId('comment-tray-stub').length).toBeGreaterThan(0);

    // But the forward-driving control is suppressed: no Resolve on the open
    // decision.
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
  });

  it('counts candidates / open / resolved in the header', () => {
    const decisions = [
      makeDecision({ status: 'candidate', seq: 1 }),
      makeDecision({ status: 'open', seq: 2 }),
      makeDecision({ status: 'open', seq: 3 }),
      makeDecision({ status: 'resolved', seq: 4 }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.getByText('1 candidate, 2 open, 1 resolved')).toBeInTheDocument();
  });

  it('resolve button on an open decision (without options) sends a "Resolve decision …" chat message', async () => {
    const user = userEvent.setup();
    const decisions = [
      makeDecision({ id: 'd1', seq: 7, status: 'open', title: 'What stack?' }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
      />
    );

    await user.click(screen.getByTestId('decision-resolve'));
    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'decision',
      id: 'd1',
      label: 'Decision D-7',
    });
    expect(mockSendMessage).toHaveBeenCalledWith('Resolve decision D-7');
  });

  // t-21 Issue 5: the manual "Add decision" UI is gone — decisions are agent-driven
  // through the candidate flow (propose_decision → approve → resolve). REST/MCP
  // power-user paths still create decisions for scripting, but the panel doesn't
  // expose a button.
  it('does NOT render a manual "Add decision" button (per t-21 Issue 5)', () => {
    render(<DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /Add decision/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Decision question/i),
    ).not.toBeInTheDocument();
  });

  it('shows agent-driven empty-state copy when the list is empty', () => {
    render(<DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} />);
    // Default tab is 'open' when no candidates exist; the empty state explains
    // the agent-driven flow (candidate → approve → open → resolve).
    expect(screen.getByText(/No open decisions/i)).toBeInTheDocument();
    expect(screen.getByText(/approve a candidate raised by the agent/i)).toBeInTheDocument();
  });

  it('Candidates tab empty state explains the agent-driven candidate flow', async () => {
    const user = userEvent.setup();
    render(<DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Candidates/i }));
    expect(screen.getByText(/No candidate decisions yet/i)).toBeInTheDocument();
    expect(screen.getByText(/agent watches for choices with multiple options/i)).toBeInTheDocument();
  });

  it('Resolved tab empty state explains the resolution flow', async () => {
    const user = userEvent.setup();
    render(<DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Resolved/i }));
    expect(screen.getByText(/No resolved decisions yet/i)).toBeInTheDocument();
    expect(screen.getByText(/durable .* record/i)).toBeInTheDocument();
  });

  // ── Candidate workflow (t-16) ─────────────────────────────────

  it('defaults to the Candidates tab when any candidate exists', () => {
    const decisions = [
      makeDecision({
        id: 'cand-1',
        seq: 1,
        status: 'candidate',
        title: 'API style?',
        options: [
          { label: 'REST', trade_offs: 'Simple, well-known' },
          { label: 'gRPC', trade_offs: 'Faster, harder tooling' },
        ],
      }),
      makeDecision({ id: 'open-1', seq: 2, status: 'open', title: 'Other?' }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    const cards = screen.getAllByTestId('decision-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-decision-status')).toBe('candidate');
    expect(cards[0].getAttribute('data-decision-seq')).toBe('D-1');

    // Both options render with their trade-offs.
    expect(screen.getByText('REST')).toBeInTheDocument();
    expect(screen.getByText('Simple, well-known')).toBeInTheDocument();
    expect(screen.getByText('gRPC')).toBeInTheDocument();
    expect(screen.getByText('Faster, harder tooling')).toBeInTheDocument();
  });

  it('Approve button on a candidate calls approveDecisionApi and refreshes', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockApproveDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({ id: 'cand-1', seq: 1, status: 'candidate', options: [] }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByTestId('candidate-approve'));
    await waitFor(() => expect(mockApproveDecisionApi).toHaveBeenCalledWith('cand-1'));
    expect(onUpdate).toHaveBeenCalled();
  });

  it('Reject flow requires a reason and calls rejectDecisionApi with it', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockRejectDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({ id: 'cand-1', seq: 1, status: 'candidate', options: [] }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByTestId('candidate-reject'));
    const reason = screen.getByTestId('candidate-reject-reason');
    const confirm = screen.getByTestId('candidate-reject-confirm') as HTMLButtonElement;
    // Empty reason disables the confirm button.
    expect(confirm.disabled).toBe(true);

    await user.type(reason, 'Out of scope for this spec');
    expect((screen.getByTestId('candidate-reject-confirm') as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId('candidate-reject-confirm'));

    await waitFor(() =>
      expect(mockRejectDecisionApi).toHaveBeenCalledWith('cand-1', 'Out of scope for this spec'),
    );
    expect(onUpdate).toHaveBeenCalled();
  });

  it('"Flag for discussion" creates a question-typed comment on the candidate', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockCreateDecisionComment.mockResolvedValue({});
    const decisions = [
      makeDecision({ id: 'cand-1', seq: 1, status: 'candidate', options: [] }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByTestId('candidate-flag'));
    await user.type(screen.getByTestId('candidate-flag-body'), 'Need product input on this one');
    await user.click(screen.getByTestId('candidate-flag-confirm'));

    await waitFor(() =>
      expect(mockCreateDecisionComment).toHaveBeenCalledWith(
        'cand-1',
        'Tester McTest',
        'Need product input on this one',
        { type: 'question' },
      ),
    );
    expect(onUpdate).toHaveBeenCalled();
  });

  it('Resolve picker on an open decision with options persists chosenOptionIndex', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockResolveDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({
        id: 'open-1',
        seq: 5,
        status: 'open',
        title: 'API?',
        options: [
          { label: 'REST', trade_offs: 'Simple' },
          { label: 'gRPC', trade_offs: 'Faster' },
        ],
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    // Toggle the resolve picker on the open card.
    await user.click(screen.getByTestId('decision-resolve'));

    // Pick the second option.
    await user.click(screen.getByTestId('open-option-1'));
    await user.type(screen.getByTestId('open-resolution-text'), 'Going with gRPC for the perf');
    await user.click(screen.getByTestId('open-resolve-confirm'));

    await waitFor(() =>
      expect(mockResolveDecisionApi).toHaveBeenCalledWith(
        'open-1',
        'Going with gRPC for the perf',
        1,
      ),
    );
    expect(onUpdate).toHaveBeenCalled();
    // The chat-based resolve flow should NOT fire when options are present.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('Resolve picker requires both an option and a non-empty resolution', async () => {
    const user = userEvent.setup();
    const decisions = [
      makeDecision({
        id: 'open-1',
        seq: 5,
        status: 'open',
        title: 'API?',
        options: [
          { label: 'REST', trade_offs: 'Simple' },
          { label: 'gRPC', trade_offs: 'Faster' },
        ],
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    await user.click(screen.getByTestId('decision-resolve'));
    const confirm = screen.getByTestId('open-resolve-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    // Selecting an option alone is not enough — text is still required.
    await user.click(screen.getByTestId('open-option-0'));
    expect((screen.getByTestId('open-resolve-confirm') as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByTestId('open-resolution-text'), 'REST it is');
    expect((screen.getByTestId('open-resolve-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the chosen-option label on a resolved decision with options[]', async () => {
    const user = userEvent.setup();
    const decisions = [
      makeDecision({
        id: 'res-1',
        seq: 9,
        status: 'resolved',
        title: 'Auth?',
        resolution: 'JWT for sessions',
        options: [
          { label: 'JWT', trade_offs: 'Stateless' },
          { label: 'Sessions', trade_offs: 'Server load' },
        ],
        chosenOptionIndex: 0,
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    // Switch to the Resolved tab.
    await user.click(screen.getByRole('button', { name: /^Resolved/ }));
    expect(screen.getByText(/Chose:/)).toBeInTheDocument();
    expect(screen.getByText(/^JWT$/)).toBeInTheDocument();
  });
});

// spec-164 dec-3 — gate the invitation, never the content. A draft Spec with
// zero decisions invites the move to Specify; existing decisions always render;
// plan-and-later behaviour is unchanged.
describe('DecisionPanel — draft-phase gating (spec-164)', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  it('draft + zero decisions → empty-state directive instead of the tabs scaffolding', () => {
    tagAc(AC164(17));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-5');
    render(
      <DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} specPhase="draft" />,
    );
    expect(screen.getByTestId('decision-draft-directive')).toHaveTextContent(
      'Move this spec to Specify to start capturing Decisions and ACs.',
    );
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('draft + an existing decision → normal render, content never hidden', () => {
    tagAc(AC164(18));
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={[makeDecision({ id: 'd-1', seq: 1, title: 'Which DB?', status: 'open' })]}
        onUpdate={vi.fn()}
        specPhase="draft"
      />,
    );
    expect(screen.queryByTestId('decision-draft-directive')).not.toBeInTheDocument();
    expect(screen.getByText('Which DB?')).toBeInTheDocument();
  });

  it('specify + zero decisions → behaviour unchanged (tabs scaffolding, no directive)', () => {
    tagAc(AC164(18));
    render(
      <DecisionPanel docId="doc-1" decisions={[]} onUpdate={vi.fn()} specPhase="specify" />,
    );
    expect(screen.queryByTestId('decision-draft-directive')).not.toBeInTheDocument();
    expect(screen.getByText('No open decisions.')).toBeInTheDocument();
  });
});
