import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DecisionPanel } from './DecisionPanel';
import type { Decision } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;
const AC247 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-247/acs/ac-${n}`;

const mockAddContextChip = vi.fn();
const mockSendMessage = vi.fn();
const mockCreateDecision = vi.fn();
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
  resolveDecisionApi: (...args: unknown[]) => mockResolveDecisionApi(...args),
  createDecisionComment: (...args: unknown[]) => mockCreateDecisionComment(...args),
}));

vi.mock('./CommentTray', () => ({
  CommentTray: ({ targetId }: { targetId: string }) => (
    <div data-testid="comment-tray-stub" data-target-id={targetId} />
  ),
}));

const PROMPT_CONTEXT = {
  namespace: 'acme',
  memex: 'main',
  handle: 'spec-1',
  title: 'A Spec',
  url: 'https://memex.ai/acme/main/specs/spec-1',
};

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

const TWO_OPTIONS = [
  { label: 'REST', trade_offs: 'Simple, well-known' },
  { label: 'gRPC', trade_offs: 'Faster, harder tooling' },
];

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

  it('a reviewer (canWrite true, canEdit false) sees the decision but the option picker is disabled (ac-9)', () => {
    tagAc(AC(9));
    const decisions = [
      makeDecision({ id: 'd1', seq: 7, status: 'open', title: 'What stack?', options: TWO_OPTIONS }),
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
    // …but the answering affordance (the option radios) is disabled for a
    // reviewer, and there is no resolve CTA for anyone (spec-247 dec-1).
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect((screen.getByTestId('open-option-0') as HTMLInputElement).disabled).toBe(true);
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

  // t-21 Issue 5: the manual "Add decision" UI is gone — decisions are agent-driven
  // through the candidate flow. REST/MCP power-user paths still create decisions
  // for scripting, but the panel doesn't expose a button.
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
    // where candidates are confirmed and that picking an option answers.
    expect(screen.getByText(/No open decisions/i)).toBeInTheDocument();
    expect(screen.getByText(/picking an option records your answer/i)).toBeInTheDocument();
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

  it('defaults to the Candidates tab when any candidate exists', () => {
    const decisions = [
      makeDecision({
        id: 'cand-1',
        seq: 1,
        status: 'candidate',
        title: 'API style?',
        options: TWO_OPTIONS,
      }),
      makeDecision({ id: 'open-1', seq: 2, status: 'open', title: 'Other?' }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    const cards = screen.getAllByTestId('decision-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-decision-status')).toBe('candidate');
    expect(cards[0].getAttribute('data-decision-seq')).toBe('D-1');

    // Both options render with their trade-offs (informational, spec-247 dec-6).
    expect(screen.getByText('REST')).toBeInTheDocument();
    expect(screen.getByText('Simple, well-known')).toBeInTheDocument();
    expect(screen.getByText('gRPC')).toBeInTheDocument();
    expect(screen.getByText('Faster, harder tooling')).toBeInTheDocument();
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
    expect(screen.getAllByText(/^JWT$/).length).toBeGreaterThan(0);
  });
});

// ── spec-247: the decision card answers; everything else explains ──────────
describe('DecisionPanel — one obvious place to answer (spec-247)', () => {
  it('renders NO CTA button on an open decision card — the option rows are the only answering control (ac-6)', () => {
    tagAc(AC247(6));
    const decisions = [
      makeDecision({ id: 'open-1', seq: 5, status: 'open', title: 'API?', options: TWO_OPTIONS }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save resolution/i })).not.toBeInTheDocument();
    // The options are present and enabled — the answering affordance.
    expect(screen.getByTestId('open-option-0')).toBeInTheDocument();
    expect(screen.getByTestId('persist-on-select-hint')).toHaveTextContent(
      /records your answer/i,
    );
  });

  it('clicking an option records the answer immediately via the resolve API (ac-7)', async () => {
    tagAc(AC247(7));
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockResolveDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({ id: 'open-1', seq: 5, status: 'open', title: 'API?', options: TWO_OPTIONS }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByTestId('open-option-1'));

    await waitFor(() =>
      expect(mockResolveDecisionApi).toHaveBeenCalledWith('open-1', undefined, 1),
    );
    expect(onUpdate).toHaveBeenCalled();
    // No prose was demanded, no agent involved.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('re-selecting a different option on a RESOLVED decision updates the choice (ac-7)', async () => {
    tagAc(AC247(7));
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockResolveDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({
        id: 'res-1',
        seq: 9,
        status: 'resolved',
        title: 'Auth?',
        resolution: 'JWT',
        options: [
          { label: 'JWT', trade_offs: 'Stateless' },
          { label: 'Sessions', trade_offs: 'Server load' },
        ],
        chosenOptionIndex: 0,
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByRole('button', { name: /^Resolved/ }));
    await user.click(screen.getByText('Context'));
    await user.click(screen.getByTestId('resolved-option-1'));

    await waitFor(() =>
      expect(mockResolveDecisionApi).toHaveBeenCalledWith('res-1', undefined, 1),
    );
    expect(onUpdate).toHaveBeenCalled();
  });

  it('an optionless open decision has NO resolve control and NEVER dispatches an agent message (ac-8)', () => {
    tagAc(AC247(8));
    const decisions = [
      makeDecision({ id: 'd1', seq: 7, status: 'open', title: 'What stack?', options: null }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.getByTestId('optionless-hint')).toHaveTextContent(/coding agent/i);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockResolveDecisionApi).not.toHaveBeenCalled();
  });

  it('no text input renders on the answering path; discussion sits behind a labelled toggle (ac-9)', async () => {
    tagAc(AC247(9));
    const user = userEvent.setup();
    const decisions = [
      makeDecision({ id: 'open-1', seq: 5, status: 'open', title: 'API?', options: TWO_OPTIONS }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    // No textarea / comment composer inside the open card by default.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comment-tray-stub')).not.toBeInTheDocument();

    // The Discussion toggle reveals the tray, labelled as never resolving.
    await user.click(screen.getByTestId('decision-discussion-toggle'));
    expect(screen.getByTestId('discussion-disclaimer')).toHaveTextContent(
      /never resolve/i,
    );
    expect(screen.getByTestId('comment-tray-stub')).toBeInTheDocument();
  });

  it('"Ask for more explanation" pre-scopes the assistant to the decision and only explains (ac-10)', async () => {
    tagAc(AC247(10));
    const user = userEvent.setup();
    const decisions = [
      makeDecision({ id: 'open-1', seq: 5, status: 'open', title: 'API?', options: TWO_OPTIONS }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
        promptContext={PROMPT_CONTEXT}
      />,
    );

    await user.click(screen.getByTestId('decision-explain'));

    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'decision',
      id: 'open-1',
      label: 'Decision D-5',
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const prompt = mockSendMessage.mock.calls[0][0] as string;
    expect(prompt).toMatch(/Explain decision D-5/);
    expect(prompt).toMatch(/Do NOT resolve/i);
    // Explanation never resolves.
    expect(mockResolveDecisionApi).not.toHaveBeenCalled();
  });

  it('candidate cards are view-only: no radios, no Approve, no Reject (ac-20)', () => {
    tagAc(AC247(20));
    const decisions = [
      makeDecision({
        id: 'cand-1',
        seq: 1,
        status: 'candidate',
        title: 'API style?',
        options: TWO_OPTIONS,
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={vi.fn()} />);

    // Options render as information — nothing selectable, nothing droppable.
    expect(screen.getByText('REST')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    // The approval process is not actionable on the web.
    expect(screen.queryByTestId('candidate-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('candidate-reject')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument();
  });

  it('candidate list carries the coding-agent boundary marker (ac-21)', () => {
    tagAc(AC247(21));
    const decisions = [
      makeDecision({
        id: 'cand-1',
        seq: 1,
        status: 'candidate',
        title: 'API style?',
        options: TWO_OPTIONS,
      }),
    ];
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={decisions}
        onUpdate={vi.fn()}
        promptContext={PROMPT_CONTEXT}
      />,
    );

    const marker = screen.getByTestId('candidate-mcp-marker');
    expect(marker).toHaveTextContent(/Review the candidate decisions/);
    expect(marker).toHaveTextContent(/coding agent/i);
    expect(marker).toHaveTextContent(/not in the browser/i);
  });

  it('"Add reasoning" on a resolved decision saves optional prose via re-resolve (ac-19)', async () => {
    tagAc(AC247(19));
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    mockResolveDecisionApi.mockResolvedValue({});
    const decisions = [
      makeDecision({
        id: 'res-1',
        seq: 9,
        status: 'resolved',
        title: 'Auth?',
        resolution: 'JWT', // equals the chosen option's label → "Add reasoning"
        options: [
          { label: 'JWT', trade_offs: 'Stateless' },
          { label: 'Sessions', trade_offs: 'Server load' },
        ],
        chosenOptionIndex: 0,
      }),
    ];
    render(<DecisionPanel docId="doc-1" decisions={decisions} onUpdate={onUpdate} />);

    await user.click(screen.getByRole('button', { name: /^Resolved/ }));
    await user.click(screen.getByText('Context'));
    await user.click(screen.getByTestId('decision-add-reasoning'));
    await user.clear(screen.getByTestId('reasoning-text'));
    await user.type(screen.getByTestId('reasoning-text'), 'Stateless wins for our edge nodes');
    await user.click(screen.getByTestId('reasoning-save'));

    await waitFor(() =>
      expect(mockResolveDecisionApi).toHaveBeenCalledWith(
        'res-1',
        'Stateless wins for our edge nodes',
        0,
      ),
    );
    expect(onUpdate).toHaveBeenCalled();
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
