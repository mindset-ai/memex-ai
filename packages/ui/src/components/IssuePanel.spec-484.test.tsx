// spec-484 t-3 / dec-2 — IssuePanel expanded body renders markdown; the
// collapsed preview stays plain.
//
//   • ac-8 / ac-13 — the EXPANDED issue body routes through the markdown
//     renderer (block mode): `- bullet` → <li>, `**bold**` → <strong>.
//   • ac-10        — the COLLAPSED line-clamp-2 preview stays PLAIN: no <li>,
//     no <strong>; the literal markdown syntax is what's shown (a single
//     clamped line, unchanged layout).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { IssuePanel } from './IssuePanel';
import type { Issue } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

const mockFetchIssues = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn() }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));
vi.mock('../api/client', () => ({
  fetchIssues: (...a: unknown[]) => mockFetchIssues(...a),
  createIssueApi: vi.fn(),
  updateIssueStatusApi: vi.fn(),
  convertIssueToTaskApi: vi.fn(),
}));

const BODY = 'Repro steps:\n\n- open **Safari**\n- click login';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Login is a no-op',
    body: BODY,
    type: 'bug',
    severity: null,
    status: 'open',
    source: 'human',
    satisfyingTaskId: null,
    promotedDocId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Issue;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchIssues.mockResolvedValue([makeIssue()]);
});

describe('spec-484: IssuePanel body markdown', () => {
  it('ac-10: the collapsed preview stays PLAIN (no li / no strong, literal syntax)', async () => {
    tagAc(AC(10));
    render(<IssuePanel docId="doc-1" />);
    const card = await screen.findByTestId('issue-card');
    // Collapsed by default — the clamped preview is a plain <p>.
    const preview = card.querySelector('.line-clamp-2');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('li')).toBeNull();
    expect(preview!.querySelector('strong')).toBeNull();
    // The literal markdown is shown, un-rendered.
    expect(preview!.textContent).toContain('**Safari**');
  });

  it('ac-8 / ac-13: the expanded body routes through the markdown renderer (li + strong)', async () => {
    tagAc(AC(8));
    tagAc(AC(13));
    render(<IssuePanel docId="doc-1" />);
    const card = await screen.findByTestId('issue-card');
    fireEvent.click(card);
    const expanded = within(card).getByTestId('issue-expanded');
    expect(expanded.querySelector('li')).not.toBeNull();
    expect(expanded.querySelector('strong')?.textContent).toBe('Safari');
    expect(expanded.textContent).not.toContain('- open **Safari**');
  });
});
