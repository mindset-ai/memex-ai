// spec-260 t-7 — the QA Reports feed page (dec-5), data hooks stubbed (the
// Pulse page-test convention). Asserts:
//   ac-8  : the list renders newest-first with an initial page + Load More.
//   ac-9  : each row shows WHEN (generation time), WHICH Spec (linked), and
//           WHO executed the session (std-32 actor).
//   ac-20 : same row metadata, plus the live-update wiring — the page
//           subscribes to the SSE bus and refetches when an event lands.
//   ac-10 : opening the page records the per-user view (the marker upsert the
//           badge zeroes on); the badge-side maths is covered in
//           useQaReports.spec-260.test.ts and the server integration tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { QaReportFeedRow, UseQaReportsFeedResult } from '../hooks/useQaReports';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

const useQaReportsFeedMock = vi.hoisted(() => vi.fn());
const recordViewMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useQaReports', () => ({
  useQaReportsFeed: (...a: unknown[]) => useQaReportsFeedMock(...a),
  recordQaReportsView: (...a: unknown[]) => recordViewMock(...a),
  QA_REPORTS_VIEWED_EVENT: 'memex:qa-reports-viewed',
}));

// Capture the SSE subscription so the test can simulate a live event.
const streamCallbacks = vi.hoisted(() => ({ current: [] as Array<() => void> }));
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: (_docId: string | null, onEvent: () => void) => {
    streamCallbacks.current.push(onEvent);
  },
}));

vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { QaReports } from './QaReports';

function row(over: Partial<QaReportFeedRow>): QaReportFeedRow {
  return {
    id: 'r-x',
    docId: 'd-1',
    docHandle: 'spec-1',
    docTitle: 'Some Spec',
    sectionType: 'qa_report',
    version: 1,
    title: 'QA Report',
    content: 'report body',
    actorName: 'Claude Code',
    actorKind: 'mcp_agent',
    channel: 'mcp',
    createdAt: '2026-06-03T00:00:00Z',
    ...over,
  };
}

const ROWS: QaReportFeedRow[] = [
  row({
    id: 'r-3',
    docHandle: 'spec-9',
    docTitle: 'Newest Spec',
    sectionType: 'qa_report-2',
    version: 2,
    content: 'NEWEST report body',
    createdAt: '2026-06-03T00:00:00Z',
  }),
  row({
    id: 'r-2',
    docHandle: 'spec-4',
    docTitle: 'Middle Spec',
    actorName: 'Barrie',
    actorKind: 'human',
    channel: 'rest_ui',
    createdAt: '2026-06-02T00:00:00Z',
  }),
  row({ id: 'r-1', docHandle: 'spec-9', docTitle: 'Newest Spec', createdAt: '2026-06-01T00:00:00Z' }),
];

let feed: UseQaReportsFeedResult;

beforeEach(() => {
  vi.clearAllMocks();
  streamCallbacks.current = [];
  feed = {
    rows: ROWS,
    loading: false,
    error: null,
    hasMore: true,
    loadOlder: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  useQaReportsFeedMock.mockImplementation(() => feed);
  // Default: marker unavailable → all rows collapsed; the ac-24 tests
  // override with a real receipt.
  recordViewMock.mockResolvedValue(null);
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/acme/main/qa-reports']}>
      <QaReports />
    </MemoryRouter>,
  );
}

describe('spec-260 — QA Reports feed page', () => {
  it('ac-8: lists reports newest-first and Load More fetches older entries', async () => {
    tagAc(AC(8));
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');
    expect(rows).toHaveLength(3);
    // Newest-first: the order the hook returned is preserved.
    expect(within(rows[0]).getByTestId('qa-report-row-spec')).toHaveTextContent('spec-9');
    expect(within(rows[1]).getByTestId('qa-report-row-spec')).toHaveTextContent('spec-4');

    // Load More rides the keyset loadOlder.
    fireEvent.click(screen.getByTestId('qa-reports-load-more'));
    expect(feed.loadOlder).toHaveBeenCalledTimes(1);
  });

  it('ac-9/ac-20: each row shows WHEN, WHICH Spec (linked), and WHO executed it', async () => {
    tagAc(AC(9));
    tagAc(AC(20));
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');

    // WHICH — the parent Spec, linked.
    const specLink = within(rows[0]).getByTestId('qa-report-row-spec');
    expect(specLink).toHaveTextContent('spec-9 · Newest Spec');
    expect(specLink.closest('a')).toHaveAttribute('href', expect.stringContaining('/specs/spec-9'));

    // WHEN — the report row's generation time.
    expect(within(rows[0]).getByTestId('qa-report-row-when')).toHaveTextContent('3 Jun 2026');

    // WHO — the std-32 actor; an mcp_agent executor is labelled as an agent,
    // a human executor by name.
    expect(within(rows[0]).getByTestId('qa-report-row-who')).toHaveTextContent('Claude Code (agent)');
    expect(within(rows[1]).getByTestId('qa-report-row-who')).toHaveTextContent('Barrie');

    // A versioned session is identified.
    expect(rows[0]).toHaveTextContent('session 2');
  });

  it('ac-20: the page subscribes to the SSE bus and refetches on a live event', () => {
    tagAc(AC(20));
    renderPage();

    // Subscribed to the whole-memex channel.
    expect(streamCallbacks.current.length).toBeGreaterThan(0);
    // A live event (a new qa_report section riding the std-8 bus) → refresh.
    streamCallbacks.current.forEach((cb) => cb());
    expect(feed.refresh).toHaveBeenCalled();
  });

  it('ac-10: opening the page records the per-user view (the badge-zeroing marker)', () => {
    tagAc(AC(10));
    renderPage();
    expect(recordViewMock).toHaveBeenCalledTimes(1);
  });

  it('renders the row body on demand (read-only markdown)', async () => {
    renderPage();
    const first = (await screen.findAllByTestId('qa-report-row'))[0];
    fireEvent.click(within(first).getByTestId('qa-report-row-toggle'));
    expect(within(first).getByTestId('qa-report-row-body')).toHaveTextContent('NEWEST report body');
  });

  it('shows the quiet empty state when no reports exist', async () => {
    feed = { ...feed, rows: [], hasMore: false };
    renderPage();
    expect(await screen.findByTestId('qa-reports-empty')).toBeInTheDocument();
  });

  // ── ac-24: unread rows open, read rows closed ────────────────────────────
  // The unread boundary is the PREVIOUS last_viewed_at from the view receipt
  // (opening the page resets the marker, so the receipt is the only place the
  // old value survives). Fixture times: r-3 = 03 Jun, r-2 = 02 Jun, r-1 = 01 Jun.

  it('ac-24: rows newer than the previous marker render expanded; read rows collapsed', async () => {
    tagAc(AC(24));
    recordViewMock.mockResolvedValue({
      lastViewedAt: '2026-06-12T00:00:00Z',
      previousLastViewedAt: '2026-06-01T12:00:00Z', // after r-1, before r-2/r-3
    });
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');
    // Unread (r-3, r-2): expanded on arrival.
    expect(within(rows[0]).getByTestId('qa-report-row-body')).toHaveTextContent(
      'NEWEST report body',
    );
    expect(within(rows[1]).queryByTestId('qa-report-row-body')).toBeInTheDocument();
    // Read (r-1): collapsed.
    expect(within(rows[2]).queryByTestId('qa-report-row-body')).not.toBeInTheDocument();

    // The user's own toggle still wins: collapsing an unread row works.
    fireEvent.click(within(rows[0]).getByTestId('qa-report-row-toggle'));
    expect(within(rows[0]).queryByTestId('qa-report-row-body')).not.toBeInTheDocument();
  });

  it('ac-24: first-ever view (no previous marker) → every row is unread and expanded', async () => {
    tagAc(AC(24));
    recordViewMock.mockResolvedValue({
      lastViewedAt: '2026-06-12T00:00:00Z',
      previousLastViewedAt: null,
    });
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');
    for (const row of rows) {
      expect(within(row).queryByTestId('qa-report-row-body')).toBeInTheDocument();
    }
  });

  it('ac-24: marker unavailable (anonymous / failed write) → all rows collapsed', async () => {
    tagAc(AC(24));
    recordViewMock.mockResolvedValue(null);
    renderPage();

    const rows = await screen.findAllByTestId('qa-report-row');
    for (const row of rows) {
      expect(within(row).queryByTestId('qa-report-row-body')).not.toBeInTheDocument();
    }
  });
});
