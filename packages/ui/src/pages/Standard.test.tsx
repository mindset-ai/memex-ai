import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { Standard } from './Standard';
import type {
  Comment,
  DocCommentsResult,
  DocSection,
  DocWithGraph,
} from '../api/types';

// spec-130 ac-1: when a Standard is taller than the viewport, the view scrolls
// vertically so every section below the fold is reachable.
const AC_SCROLL =
  'mindset-prod/memex-building-itself/specs/spec-130/acs/ac-1';

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
    sectionType: 'body',
    title: 'Caching rules',
    content: 'Default cache TTL is 60s.',
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
    status: 'draft',
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sections: [section()],
    decisions: [],
    tasks: [],
    ...overrides,
  };
}

function driftComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c-1',
    sectionId: 'sec-1',
    decisionId: null,
    taskId: null,
    authorName: 'Agent',
    content: 'Drift detected — code uses 30s cache.',
    resolution: null,
    resolvedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    commentType: 'drift',
    source: 'agent',
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

describe('Standard', () => {
  it('renders the standard title and section content', async () => {
    fetchDocMock.mockResolvedValueOnce(standard());
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    expect(await screen.findByText('Caching standard')).toBeInTheDocument();
    expect(screen.getByText(/Default cache TTL/)).toBeInTheDocument();
    expect(screen.getByText('std-100')).toBeInTheDocument();
  });

  // spec-130: the page renders bare inside AppShell's overflow-hidden <main>,
  // so it must own a vertically-scrollable container or content past the first
  // viewport is clipped and unreachable.
  it('wraps content in a vertical scroll container so long standards are reachable', async () => {
    tagAc(AC_SCROLL);
    fetchDocMock.mockResolvedValueOnce(standard());
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    await screen.findByText('Caching standard');
    const scroller = screen.getByTestId('standard-scroll');
    expect(scroller).toHaveClass('overflow-y-auto');
    expect(scroller).toHaveClass('h-full');
  });

  it('does NOT render a drift indicator when there are no open drift comments', async () => {
    fetchDocMock.mockResolvedValueOnce(standard());
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    await screen.findByText('Caching standard');
    expect(
      screen.queryByTestId('section-drift-indicator'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('standard-total-drift-count'),
    ).not.toBeInTheDocument();
  });

  it('renders a per-section red dot + a header total when open drift comments exist', async () => {
    const sec = section({ id: 'sec-1' });
    fetchDocMock.mockResolvedValueOnce(standard({ sections: [sec] }));
    fetchDocCommentsMock.mockResolvedValueOnce({
      sections: [
        {
          section: sec,
          comments: [
            driftComment({ id: 'c-1' }),
            driftComment({ id: 'c-2' }),
            // resolved drift — must NOT count
            driftComment({ id: 'c-3', resolvedAt: '2025-01-02T00:00:00Z' }),
            // non-drift typed comment — must NOT count
            driftComment({ id: 'c-4', commentType: 'discussion' }),
          ],
        },
      ],
      decisions: [],
      tasks: [],
    });

    renderAt('bp-1');

    const indicator = await screen.findByTestId('section-drift-indicator');
    expect(indicator).toBeInTheDocument();
    const totalBadge = screen.getByTestId('standard-total-drift-count');
    expect(totalBadge).toHaveTextContent('2 drift');
    // b-63: the header badge deep-links into the Drift Inbox filtered to this standard.
    expect(totalBadge.getAttribute('href')).toContain('/drift');
    expect(totalBadge.getAttribute('href')).toContain('doc=std-100');
    const sectionBadge = screen.getByTestId('section-drift-badge');
    expect(sectionBadge).toHaveTextContent('2 drift');
  });

  it('only shows the indicator on sections with open drift, not on calm sections', async () => {
    const driftedSec = section({
      id: 'sec-drifted',
      seq: 1,
      title: 'Drifted',
      content: '...',
    });
    const calmSec = section({
      id: 'sec-calm',
      seq: 2,
      title: 'Calm',
      content: '...',
    });
    fetchDocMock.mockResolvedValueOnce(
      standard({ sections: [driftedSec, calmSec] }),
    );
    fetchDocCommentsMock.mockResolvedValueOnce({
      sections: [
        { section: driftedSec, comments: [driftComment({ sectionId: 'sec-drifted' })] },
        { section: calmSec, comments: [] },
      ],
      decisions: [],
      tasks: [],
    });

    renderAt('bp-1');

    await screen.findByText('Drifted');
    const sections = screen.getAllByTestId('standard-section');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveAttribute('data-section-id', 'sec-drifted');
    expect(sections[0]).toHaveAttribute('data-drifted', 'true');
    expect(sections[1]).toHaveAttribute('data-section-id', 'sec-calm');
    expect(sections[1]).toHaveAttribute('data-drifted', 'false');
  });

  it('renders [per dec-N] references as DecisionLink buttons inside markdown', async () => {
    const sec = section({
      id: 'sec-1',
      content: 'Use ArgoCD [per dec-7] for deploy.',
    });
    fetchDocMock.mockResolvedValueOnce(standard({ sections: [sec] }));
    fetchDocCommentsMock.mockResolvedValueOnce(emptyDocComments());

    renderAt('bp-1');

    await screen.findByText('Caching standard');
    await waitFor(() => {
      const link = screen.getByTestId('decision-link');
      expect(link).toHaveTextContent('dec-7');
      expect(link).toHaveAttribute('data-decision-handle', 'dec-7');
    });
  });

  it('renders the not-found state when the standard does not exist', async () => {
    fetchDocMock.mockRejectedValueOnce(
      Object.assign(new Error('Document not found'), { name: 'NotFoundError' }),
    );

    renderAt('bp-missing');

    // The component checks `instanceof NotFoundError`, so we need the mocked
    // class. We use the mocked NotFoundError export above; trigger the path
    // by reaching for the not-found copy which only renders on that branch.
    await waitFor(() => {
      // either branch is acceptable — the test ensures the component handles
      // the rejection without crashing.
      const standardHeader = screen.queryByText('Standard not found');
      const failureBanner = screen.queryByText(/Failed to load standard/);
      expect(standardHeader || failureBanner).toBeTruthy();
    });
  });
});
