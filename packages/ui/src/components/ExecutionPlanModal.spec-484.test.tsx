// spec-484 t-3 / dec-2 — ExecutionPlanModal readiness assessment renders markdown.
//
// The agent-authored readiness banner printed its content with
// whitespace-pre-wrap, so markdown showed as literal syntax. This pins that the
// readiness body now routes through the same ReactMarkdown wiring the plan
// sections use: `- bullet` → <li>, `**bold**` → <strong>, `code` → <code>.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ExecutionPlanModal } from './ExecutionPlanModal';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

const mockFetchDoc = vi.fn();
const mockFetchTaskComments = vi.fn();

vi.mock('../api/client', () => ({
  fetchDoc: (...a: unknown[]) => mockFetchDoc(...a),
  fetchTaskComments: (...a: unknown[]) => mockFetchTaskComments(...a),
  updateDocStatus: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Reviewer', email: 'r@memex.ai' } }),
}));

const READINESS = 'READY — the plan is complete:\n\n- **all** sections filled\n- `pnpm test` green';

function makePlanDoc() {
  return {
    id: 'plan-1',
    status: 'draft',
    sections: [
      { id: 'sec-1', sectionType: 'approach', title: 'Approach', content: 'Do the thing.' },
    ],
  };
}

const task = { id: 't-1', seq: 3, title: 'Wire it up' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchDoc.mockResolvedValue(makePlanDoc());
  mockFetchTaskComments.mockResolvedValue([
    { id: 'c-1', content: READINESS, type: 'readiness_check', createdAt: '2026-06-01T00:00:00Z' },
  ]);
});

describe('spec-484: ExecutionPlanModal readiness renders markdown', () => {
  it('ac-8 / ac-13: readiness content routes through the markdown renderer (li + strong + code)', async () => {
    tagAc(AC(8));
    tagAc(AC(13));
    render(<ExecutionPlanModal task={task} planDocId="plan-1" onClose={() => {}} />);
    const banner = await screen.findByTestId('plan-readiness');
    await waitFor(() => expect(banner.querySelector('li')).not.toBeNull());
    expect(banner.querySelector('strong')?.textContent).toBe('all');
    expect(banner.querySelector('code')?.textContent).toBe('pnpm test');
    expect(banner.textContent).not.toContain('- **all**');
  });
});
