import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { Standard } from './Standard';
import type { DocCommentsResult, DocSection, DocWithGraph } from '../api/types';

// spec-449 dec-1 (ac-10): Standards have no draft/approved lifecycle — a Standard
// is a rule in force, not a doc moving through a pipeline — so the detail page
// renders NO status badge. The <Badge> renders the raw status string as its text
// ('draft' / 'approved'), so its absence is asserted by that text not appearing.
const AC_NO_STATUS =
  'mindset-prod/memex-building-itself/specs/spec-449/acs/ac-10';

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocMock = vi.fn();
const fetchDocCommentsMock = vi.fn();
const fetchDecisionByHandleMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDoc: (...args: unknown[]) => fetchDocMock(...args),
  fetchDocComments: (...args: unknown[]) => fetchDocCommentsMock(...args),
  fetchDecisionByHandle: (...args: unknown[]) =>
    fetchDecisionByHandleMock(...args),
  NotFoundError: class extends Error {},
}));

function section(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: 'sec-1',
    sectionType: 'rule',
    title: 'Rule',
    content: 'Always X.',
    seq: 1,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function standard(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'bp-1',
    handle: 'std-100',
    title: 'Caching standard',
    docType: 'standard',
    status: 'approved',
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sections: [section()],
    decisions: [],
    tasks: [],
    ...overrides,
  };
}

function emptyDocComments(): DocCommentsResult {
  return { sections: [], decisions: [], tasks: [] };
}

function renderAt(standardId: string) {
  return render(
    <MemoryRouter initialEntries={[`/standards/${standardId}`]}>
      <Routes>
        <Route path="/standards/:id" element={<Standard />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Standard — no draft/approved status badge (spec-449)', () => {
  it('renders no lifecycle status badge for an approved standard', async () => {
    tagAc(AC_NO_STATUS);
    // scope ac-1: a Standard never displays a lifecycle status on any UI surface.
    tagAc('mindset-prod/memex-building-itself/specs/spec-449/acs/ac-1');
    fetchDocMock.mockResolvedValueOnce(standard({ status: 'approved' }));
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    // Header still renders the handle + docType — only the status badge is gone.
    expect(await screen.findByText('std-100')).toBeInTheDocument();
    expect(screen.getByText('standard')).toBeInTheDocument();
    // The removed <Badge> rendered its status as text; it must not appear.
    expect(screen.queryByText('approved')).not.toBeInTheDocument();
  });

  it('renders no lifecycle status badge even for a legacy draft standard', async () => {
    tagAc(AC_NO_STATUS);
    // A standard that pre-dates the born-approved change (or was never migrated)
    // still shows no status — the UI never surfaces the lifecycle field.
    fetchDocMock.mockResolvedValueOnce(standard({ status: 'draft' }));
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    expect(await screen.findByText('std-100')).toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();
  });
});
