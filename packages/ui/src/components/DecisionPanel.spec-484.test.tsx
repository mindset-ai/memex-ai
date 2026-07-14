// spec-484 t-3 / dec-2 — decision option trade_offs render markdown.
//
// The candidate/open/resolved option rows used to print `opt.trade_offs` as
// plain text (whitespace-pre-wrap), so authored markdown showed as literal
// syntax. This pins that the trade_offs now route through the shared markdown
// renderer (block mode): `- bullet` → <li>, `**bold**` → <strong>.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { DecisionPanel } from './DecisionPanel';
import type { Decision } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn(), sendMessage: vi.fn() }),
}));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Tester', email: 'tester@memex.ai' } }),
}));
vi.mock('../api/client', () => ({
  createDecision: vi.fn(),
  resolveDecisionApi: vi.fn(),
  createDecisionComment: vi.fn(),
  fetchAcsForBrief: vi.fn().mockResolvedValue([]),
}));
vi.mock('./CommentTray', () => ({
  CommentTray: () => <div data-testid="comment-tray-stub" />,
}));

const TRADE_OFFS = 'Trade-offs:\n\n- **Fast** to build\n- Cheap to run';

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `dec-${Math.random().toString(36).slice(2, 6)}`,
    docId: 'doc-1',
    seq: 1,
    title: 'Which database?',
    context: '',
    status: 'candidate',
    resolution: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    options: [{ label: 'Postgres', trade_offs: TRADE_OFFS }],
    chosenOptionIndex: null,
    ...overrides,
  } as Decision;
}

beforeEach(() => vi.clearAllMocks());

describe('spec-484: DecisionPanel trade_offs render markdown', () => {
  it('ac-7 / ac-13: candidate option trade_offs route through the markdown renderer (li + strong)', () => {
    tagAc(AC(7));
    tagAc(AC(13));
    const { container, getByTestId } = render(
      <DecisionPanel docId="doc-1" decisions={[makeDecision()]} onUpdate={vi.fn()} />,
    );
    const opts = getByTestId('candidate-options');
    // Rendered markdown, not literal syntax.
    expect(opts.querySelector('li')).not.toBeNull();
    expect(opts.querySelector('strong')).not.toBeNull();
    expect(opts.querySelector('strong')?.textContent).toBe('Fast');
    // The raw markdown bullet/asterisks must NOT survive as visible literal text.
    expect(container.textContent).not.toContain('- **Fast**');
  });
});
