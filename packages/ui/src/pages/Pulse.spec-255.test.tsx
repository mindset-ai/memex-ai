import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocSummary } from '../api/types';
import type { ActivityRow, PresentRow } from '../components/pulse/types';
import type { UsePulseHistoryResult } from '../hooks/usePulseHistory';

// spec-255 — Pulse enhancement layout: Vitals -> Hot Specs -> Live -> Working
// Now (dec-1), two coexisting bands (dec-6), Live shrunk, Needs Attention +
// filters untouched, and heat read from PERSISTED history (not the live buffer).
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;
const USER = 'u-1';

let capturedOnRow: ((row: ActivityRow) => void) | null = null;
const usePulseStreamMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePulseStream', () => ({
  usePulseStream: (opts: unknown) => usePulseStreamMock(opts),
}));
const usePulseHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePulseHistory', () => ({
  usePulseHistory: (filters: unknown) => usePulseHistoryMock(filters),
}));
const usePresenceMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePresence', () => ({
  usePresence: (refs: unknown) => usePresenceMock(refs),
}));
const useTestSignalPulseMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useTestSignalPulse', () => ({
  useTestSignalPulse: (w?: number) => useTestSignalPulseMock(w),
}));
const fetchDocsMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
}));
const useNeedsAttentionMock = vi.hoisted(() => vi.fn());
vi.mock('../components/pulse/tray/useNeedsAttention', () => ({
  useNeedsAttention: (briefId?: string) => useNeedsAttentionMock(briefId),
}));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    token: 'fake',
    session: {
      user: { id: USER },
      memberships: [{ slug: 'acme', memexSlug: 'main', memexName: 'Main', name: 'Acme' }],
    },
  }),
}));

import { Pulse } from './Pulse';

let rowSeq = 0;
function row(o: Partial<ActivityRow> = {}): ActivityRow {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    memexId: 'mx-1',
    briefId: 'sb-1',
    actorUserId: USER,
    actorName: 'Barrie',
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: null,
    entity: 'decision',
    action: 'updated',
    narrative: 'Did a thing',
    payload: null,
    createdAt: new Date().toISOString(),
    ...o,
  };
}
function spec(o: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'sb-1',
    handle: 'spec-1',
    title: 'A spec',
    docType: 'spec',
    status: 'build',
    parentDocId: null,
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sectionCount: 0,
    pausedAt: null,
    archivedAt: null,
    ...o,
  } as DocSummary;
}
function history(o: Partial<UsePulseHistoryResult> = {}): UsePulseHistoryResult {
  return { rows: [], loading: false, error: null, hasMore: false, loadOlder: vi.fn(), refresh: vi.fn(), ...o };
}
function present(o: Partial<PresentRow> = {}): PresentRow {
  return {
    memexId: 'mx-1',
    docId: 'sb-1',
    actorUserId: 'u-2',
    actorName: 'Barrie',
    actorKind: 'mcp_agent',
    channel: 'mcp',
    clientId: 'sess-1',
    lastSeenAt: new Date().toISOString(),
    source: 'floor',
    ...o,
  };
}
const EMPTY_ATTENTION = {
  unresolvedDecisions: { count: 0, items: [] },
  openQuestions: { count: 0, items: [] },
  driftSignals: { count: 0, items: [] },
  blockedTasks: { count: 0, items: [] },
  loading: false,
  error: null,
  refresh: vi.fn(),
};

function renderPulse() {
  return render(
    <MemoryRouter initialEntries={['/acme/main/pulse']}>
      <Routes>
        <Route path="/:namespace/:memex/pulse" element={<Pulse />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  capturedOnRow = null;
  usePulseStreamMock.mockReset();
  usePulseHistoryMock.mockReset();
  usePresenceMock.mockReset();
  fetchDocsMock.mockReset();
  useNeedsAttentionMock.mockReset();
  useTestSignalPulseMock.mockReset();

  usePulseStreamMock.mockImplementation((opts: { onRow?: (r: ActivityRow) => void }) => {
    capturedOnRow = opts?.onRow ?? null;
    return { status: 'connected' };
  });
  useNeedsAttentionMock.mockReturnValue(EMPTY_ATTENTION);
  usePresenceMock.mockReturnValue({ rows: [], loading: false });
  fetchDocsMock.mockResolvedValue([]);
  usePulseHistoryMock.mockReturnValue(history());
  useTestSignalPulseMock.mockReturnValue({ pulse: null, loading: false, error: null, fetchedAt: 0, refresh: vi.fn() });
});

function follows(a: HTMLElement, b: HTMLElement): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('Pulse enhancement layout (spec-255)', () => {
  it('orders the bands Vitals -> Hot Specs -> Live -> Working Now', async () => {
    tagAc(AC(7));
    fetchDocsMock.mockResolvedValue([spec({ id: 'sb-1', handle: 'spec-1' })]);
    usePresenceMock.mockReturnValue({ rows: [present({ docId: 'sb-1' })], loading: false });
    usePulseHistoryMock.mockReturnValue(
      history({ rows: [row({ briefId: 'sb-1', createdAt: new Date(Date.now() - 20_000).toISOString() })] }),
    );
    renderPulse();
    const vitals = await screen.findByTestId('vitals-strip');
    const hot = screen.getByTestId('hot-specs');
    const live = screen.getByTestId('live-band');
    const working = screen.getByTestId('working-now');
    expect(follows(vitals, hot)).toBe(true);
    expect(follows(hot, live)).toBe(true);
    expect(follows(live, working)).toBe(true);
  });

  it('shows BOTH bands at once, with no lens toggle (two bands, dec-6)', async () => {
    tagAc(AC(8));
    renderPulse();
    expect(await screen.findByTestId('hot-specs')).toBeInTheDocument();
    expect(screen.getByTestId('working-now')).toBeInTheDocument();
    expect(screen.queryByTestId('lens-toggle')).toBeNull();
  });

  it('keeps the filters and the Needs Attention tray untouched', async () => {
    tagAc(AC(1));
    renderPulse();
    expect(await screen.findByTestId('needs-attention-tray')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Just me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filtering activity to all Specs/i })).toBeInTheDocument();
    expect(screen.getByTestId('working-now')).toBeInTheDocument();
  });

  it('demotes + shrinks the Live log (bounded height, not the page-filling band)', async () => {
    tagAc(AC(2));
    renderPulse();
    const live = await screen.findByTestId('live-band');
    expect(live.className).toMatch(/max-h-/);
    expect(live.className).not.toMatch(/flex-1/);
  });

  it('ranks Hot Specs from PERSISTED history, not the live SSE buffer', async () => {
    tagAc(AC(17));
    fetchDocsMock.mockResolvedValue([
      spec({ id: 'sb-H', handle: 'spec-h' }),
      spec({ id: 'sb-L', handle: 'spec-l' }),
    ]);
    usePulseHistoryMock.mockReturnValue(
      history({ rows: [row({ briefId: 'sb-H', createdAt: new Date(Date.now() - 20_000).toISOString() })] }),
    );
    renderPulse();
    await screen.findByTestId('hot-specs');
    // Persisted spec is a card.
    expect(screen.getByTestId('hot-spec-card')).toHaveAttribute('data-doc-id', 'sb-H');

    // Push a LIVE-only row for a different spec through the stream callback.
    act(() => {
      capturedOnRow?.(row({ id: 'live-L', briefId: 'sb-L', createdAt: new Date().toISOString() }));
    });

    // Hot Specs still ranks only the persisted spec — the live buffer did not
    // create a card (heat reads activity_log, not the SSE buffer).
    const cards = screen.getAllByTestId('hot-spec-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-doc-id', 'sb-H');
  });

  it('surfaces a quiet spec as "quiet Nm" and counts only meaningful events', async () => {
    tagAc(AC(6));
    fetchDocsMock.mockResolvedValue([
      spec({ id: 'sb-Q', handle: 'spec-q' }),
      spec({ id: 'sb-R', handle: 'spec-r' }),
    ]);
    usePresenceMock.mockReturnValue({ rows: [], loading: false }); // nobody present
    usePulseHistoryMock.mockReturnValue(
      history({
        rows: [
          // sb-Q: last meaningful event 7 min ago → quiet, still in band.
          row({ briefId: 'sb-Q', entity: 'task', action: 'updated', createdAt: new Date(Date.now() - 7 * 60_000).toISOString() }),
          // sb-R: only a READ action → not meaningful → must NOT become a hot spec.
          row({ briefId: 'sb-R', entity: 'document', action: 'viewed', createdAt: new Date(Date.now() - 30_000).toISOString() }),
        ],
      }),
    );
    renderPulse();
    await userEvent.click(screen.getByRole('radio', { name: 'Just me' }));

    const cards = await screen.findAllByTestId('hot-spec-card');
    const ids = cards.map((c) => c.getAttribute('data-doc-id'));
    expect(ids).toContain('sb-Q');
    expect(ids).not.toContain('sb-R'); // read-only activity excluded
    const quietCard = cards.find((c) => c.getAttribute('data-doc-id') === 'sb-Q')!;
    expect(within(quietCard).getByTestId('hot-spec-state')).toHaveTextContent('quiet 7m');
  });
});
