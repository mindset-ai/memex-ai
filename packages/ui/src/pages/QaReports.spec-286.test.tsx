import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

import { QaReports } from './QaReports';
import {
  useQaReportsFeed,
  useQaReportTagFacets,
  recordQaReportsView,
  type QaReportFeedRow,
  type QaReportFacets,
} from '../hooks/useQaReports';

const AC_1 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-1';
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-2';
const AC_3 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-3';
const AC_7 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-7';
const AC_11 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-11';
const AC_12 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-12';

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
// PageHeader pulls in the auth/tenant chain — not under test here; stub it.
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('../hooks/useQaReports', () => ({
  useQaReportsFeed: vi.fn(),
  useQaReportTagFacets: vi.fn(),
  recordQaReportsView: vi.fn(),
}));

const ROWS: QaReportFeedRow[] = [
  {
    id: 'r1',
    docId: 'd1',
    docHandle: 'spec-100',
    docTitle: 'Alpha feature',
    phase: 'build',
    sectionType: 'qa_report',
    version: 1,
    title: 'QA Report',
    content: '# Inner heading\n\nSome report body.',
    authorName: 'Ada Author',
    actorName: 'Builder Bot',
    actorKind: 'mcp_agent',
    channel: 'mcp',
    tags: [{ id: 't-frontend', scope: 'area', value: 'frontend' }],
    createdAt: '2026-06-13T10:00:00.000Z',
  },
  {
    id: 'r2',
    docId: 'd2',
    docHandle: 'spec-101',
    docTitle: 'Beta cleanup',
    phase: 'done',
    sectionType: 'qa_report',
    version: 1,
    title: 'QA Report',
    content: 'Body only.',
    authorName: 'Cy Coder',
    actorName: 'Cy Coder', // author built it themselves → implementer hidden
    actorKind: 'human',
    channel: 'rest_ui',
    tags: [],
    createdAt: '2026-06-12T10:00:00.000Z',
  },
];

const FACETS: QaReportFacets = {
  total: 5,
  tags: [
    { id: 't-frontend', scope: 'area', value: 'frontend', count: 3 },
    { id: 't-bug', scope: null, value: 'bug', count: 2 },
  ],
};

const mockedFeed = vi.mocked(useQaReportsFeed);
const mockedFacets = vi.mocked(useQaReportTagFacets);
const mockedView = vi.mocked(recordQaReportsView);

function renderPage() {
  return render(
    <MemoryRouter>
      <QaReports />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedFeed.mockReset();
  mockedFeed.mockImplementation(() => ({
    rows: ROWS,
    loading: false,
    error: null,
    hasMore: false,
    loadOlder: vi.fn(),
    refresh: vi.fn(),
  }));
  mockedFacets.mockReset();
  mockedFacets.mockReturnValue({ facets: FACETS, loading: false, error: null, refresh: vi.fn() });
  mockedView.mockReset();
  // null receipt → boundary 'all' → rows render collapsed (deterministic).
  mockedView.mockResolvedValue(null);
});

describe('QaReports card (spec-286)', () => {
  it('ac-3 + ac-1: the spec is the dominant accent-coloured heading above the report', async () => {
    tagAc(AC_3);
    tagAc(AC_1);
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');
    const link = within(rows[0]).getByTestId('qa-report-row-spec');
    expect(link).toHaveTextContent('spec-100');
    expect(link).toHaveTextContent('Alpha feature');
    // ac-3: rendered in the accent colour.
    expect(link.className).toContain('text-accent');
    // ac-1: the heading is the dominant element (h3, text-lg) …
    const heading = link.closest('h3');
    expect(heading).not.toBeNull();
    expect(heading!.className).toContain('text-lg');

    // … and the report body renders with the subordinate `.prose-qa` scale.
    fireEvent.click(within(rows[0]).getByTestId('qa-report-row-toggle'));
    const body = within(rows[0]).getByTestId('qa-report-row-body');
    expect(body.className).toContain('prose-qa');
  });

  it('ac-2: metadata shows a phase pill coloured to the phase, plus author and relative time', async () => {
    tagAc(AC_2);
    renderPage();
    const rows = await screen.findAllByTestId('qa-report-row');

    // build → blue phase tokens; done → neutral grey.
    const buildPill = within(rows[0]).getByTestId('qa-report-phase-pill');
    expect(buildPill).toHaveAttribute('data-phase', 'build');
    expect(buildPill).toHaveTextContent('Build');
    expect(buildPill.className).toContain('phase-build');

    const donePill = within(rows[1]).getByTestId('qa-report-phase-pill');
    expect(donePill).toHaveTextContent('Done');
    expect(donePill.className).toContain('status-neutral');

    expect(within(rows[0]).getByTestId('qa-report-row-author')).toHaveTextContent('Ada Author');
    // relative time, not an absolute date.
    expect(within(rows[0]).getByTestId('qa-report-row-when')).toHaveTextContent(/ago|just now|\d/);
  });

  it('ac-7: implementer shows only when different from the author', async () => {
    tagAc(AC_7);
    renderPage();
    const rows = await screen.findAllByTestId('qa-report-row');

    // r1: Builder Bot ≠ Ada Author → implementer shown.
    expect(within(rows[0]).getByTestId('qa-report-row-implementer')).toHaveTextContent('Builder Bot');
    // r2: author built it themselves → no separate implementer line.
    expect(within(rows[1]).queryByTestId('qa-report-row-implementer')).toBeNull();
  });
});

describe('QaReports bulk expand/collapse (spec-286)', () => {
  it('ac-12: one control opens every report, then collapses them all', async () => {
    tagAc(AC_12);
    renderPage();
    const rows = await screen.findAllByTestId('qa-report-row');

    // Rows start collapsed (boundary 'all').
    expect(within(rows[0]).queryByTestId('qa-report-row-body')).toBeNull();
    expect(within(rows[1]).queryByTestId('qa-report-row-body')).toBeNull();

    // Expand all → every report body is shown.
    const toggle = screen.getByTestId('qa-reports-expand-all');
    expect(toggle).toHaveTextContent('Expand all');
    fireEvent.click(toggle);
    expect(within(rows[0]).getByTestId('qa-report-row-body')).toBeInTheDocument();
    expect(within(rows[1]).getByTestId('qa-report-row-body')).toBeInTheDocument();
    expect(toggle).toHaveTextContent('Collapse all');

    // Collapse all → every report body is hidden again.
    fireEvent.click(toggle);
    expect(within(rows[0]).queryByTestId('qa-report-row-body')).toBeNull();
    expect(within(rows[1]).queryByTestId('qa-report-row-body')).toBeNull();
  });
});

describe('QaReports filter wiring (spec-286)', () => {
  it('ac-11: tag + date filters compose with AND, and "All" clears the tag', async () => {
    tagAc(AC_11);
    renderPage();
    await screen.findAllByTestId('qa-report-row');

    const lastFilters = () => mockedFeed.mock.calls.at(-1)![0] as {
      tagId?: string;
      from?: string;
      to?: string;
    };

    // Initial: unfiltered.
    expect(lastFilters()).toMatchObject({ tagId: undefined, from: undefined, to: undefined });

    // Select a tag → feed filtered by it.
    fireEvent.click(
      screen.getAllByTestId('qa-reports-tag-node').find((n) => n.getAttribute('data-tag-id') === 't-frontend')!,
    );
    expect(lastFilters().tagId).toBe('t-frontend');

    // Add a date range → BOTH apply (AND): tag stays, from is set.
    fireEvent.click(screen.getByTestId('qa-reports-range-week'));
    const both = lastFilters();
    expect(both.tagId).toBe('t-frontend');
    expect(typeof both.from).toBe('string');

    // Click "All" → tag cleared; the date window persists (it's a separate axis).
    fireEvent.click(screen.getByTestId('qa-reports-tag-all'));
    const cleared = lastFilters();
    expect(cleared.tagId).toBeUndefined();
    expect(typeof cleared.from).toBe('string');
  });
});
