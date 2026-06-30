// spec-423 (dec-7) — a decision's cast facet keys render as pills on its card.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DecisionPanel } from './DecisionPanel';
import type { Decision } from '../api/types';

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn(), sendMessage: vi.fn() }),
}));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Tester', email: 'tester@memex.ai' } }),
}));
vi.mock('../api/client', () => ({
  createDecision: vi.fn(),
  approveDecisionApi: vi.fn(),
  rejectDecisionApi: vi.fn(),
  resolveDecisionApi: vi.fn(),
  createDecisionComment: vi.fn(),
  fetchAcsForBrief: vi.fn().mockResolvedValue([]),
}));
vi.mock('./CommentTray', () => ({
  CommentTray: ({ targetId }: { targetId: string }) => (
    <div data-testid="comment-tray-stub" data-target-id={targetId} />
  ),
}));

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Which database?',
    context: null,
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

describe('DecisionPanel facet pills (spec-423 dec-7)', () => {
  it('renders the cast facet keys as pills on an open decision card', () => {
    render(
      <DecisionPanel
        docId="doc-1"
        decisions={[makeDecision({ facetKeys: ['security', 'db-migrations'] })]}
        onUpdate={vi.fn()}
      />,
    );
    const card = screen.getByTestId('decision-card');
    const pills = within(card).getAllByTestId('facet-pill');
    expect(pills.map((p) => p.getAttribute('data-facet-key'))).toEqual(['security', 'db-migrations']);
  });

  it('renders no pills when the decision governs no facet', () => {
    render(
      <DecisionPanel docId="doc-1" decisions={[makeDecision({ facetKeys: [] })]} onUpdate={vi.fn()} />,
    );
    expect(screen.queryByTestId('facet-pill')).toBeNull();
  });
});
