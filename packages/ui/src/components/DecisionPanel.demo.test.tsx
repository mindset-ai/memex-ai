// spec-178 (A-UI, t-7): the demo variant of DecisionPanel suppresses handle
// auto-linking in decision context / resolution prose, mirroring SectionCard. A
// frozen demo spec's refs belong to the original spec-64's world, so they must
// stay plain text rather than become navigable links (ac-24). ac-11 pins the
// no-regression baseline (a non-demo decision keeps its auto-links).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DecisionPanel } from './DecisionPanel';
import type { Decision } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC_178 = 'mindset-prod/memex-building-itself/specs/spec-178';
const AC = (n: number) => `${SPEC_178}/acs/ac-${n}`;

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
  // The polling effect calls this on mount; return an empty AC set.
  fetchAcsForBrief: vi.fn().mockResolvedValue([]),
}));
vi.mock('./CommentTray', () => ({
  CommentTray: ({ targetId }: { targetId: string }) => (
    <div data-testid="comment-tray-stub" data-target-id={targetId} />
  ),
}));

const REF = 'mindset-prod/memex-building-itself/specs/spec-34';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Which database?',
    context: `Builds on ${REF}, the prior decision.`,
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

describe('DecisionPanel demo handle suppression (spec-178)', () => {
  it('ac-24: a demo decision renders a handle ref in its context as plain text', () => {
    tagAc(AC(24));
    // An OPEN decision is expanded by default, so its context markdown renders.
    render(
      <DecisionPanel docId="doc-1" decisions={[makeDecision()]} onUpdate={vi.fn()} isDemo />,
    );
    const panel = screen.getByTestId('decision-panel');
    expect(panel).toHaveTextContent(REF);
    // No anchor / ref-link element anywhere in the demo decision prose.
    expect(panel.querySelector('a')).toBeNull();
    expect(panel.querySelector('[data-ref-link="true"]')).toBeNull();
  });

  it('ac-11: a non-demo decision renders unchanged — the handle ref IS an auto-link', () => {
    tagAc(AC(11));
    render(
      <DecisionPanel docId="doc-1" decisions={[makeDecision()]} onUpdate={vi.fn()} />,
    );
    const panel = screen.getByTestId('decision-panel');
    const link = within(panel).getByRole('link', { name: REF });
    expect(link).toHaveAttribute('href', `/${REF}`);
    expect(link).toHaveAttribute('data-ref-link', 'true');
  });
});
