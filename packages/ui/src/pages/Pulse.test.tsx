import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocSummary } from '../api/types';
import type { ActivityRow, PresentRow } from '../components/pulse/types';
import type { UsePulseHistoryResult } from '../hooks/usePulseHistory';

const CURRENT_USER = 'u-1';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-122/acs/ac-${n}`;

// ── Mock the data hooks + the spec-list fetch so the page is deterministic. ──

// usePulseStream: never opens a real EventSource. Capture its options so we can
// assert/refrain, and let tests drive `status`.
const usePulseStreamMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePulseStream', () => ({
  usePulseStream: (opts: unknown) => usePulseStreamMock(opts),
}));

// usePulseHistory: capture the filters it was called with (scope/spec/client)
// and return whatever rows the test queued.
const usePulseHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePulseHistory', () => ({
  usePulseHistory: (filters: unknown) => usePulseHistoryMock(filters),
}));

// usePresence: the presence poll feeding the "Working now" zone. Never opens a
// real fetch; tests queue the present rows.
const usePresenceMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/usePresence', () => ({
  usePresence: (refs: unknown) => usePresenceMock(refs),
}));

// useTestSignalPulse: the test-signal monitor's baseline fetch. Stub it empty so
// the monitor renders its "no signals" state and no real fetch fires.
const useTestSignalPulseMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useTestSignalPulse', () => ({
  useTestSignalPulse: (windowMinutes?: number) => useTestSignalPulseMock(windowMinutes),
}));

// The spec list the picker reads.
const fetchDocsMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
}));

// The tray's data hook — keep it resolved + empty so tiles render (not endless
// skeletons) and no real fetch fires.
const useNeedsAttentionMock = vi.hoisted(() => vi.fn());
vi.mock('../components/pulse/tray/useNeedsAttention', () => ({
  useNeedsAttention: (briefId?: string) => useNeedsAttentionMock(briefId),
}));

// AuthContext: minimal session carrying the current user's id (chips/scope need
// it) plus a membership so the header title resolver doesn't throw.
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    token: 'fake',
    session: {
      user: { id: CURRENT_USER },
      memberships: [
        { slug: 'acme', memexSlug: 'main', memexName: 'Main', name: 'Acme' },
      ],
    },
  }),
}));

import { Pulse } from './Pulse';

// ── Fixtures ──────────────────────────────────────────────────────────────

let rowSeq = 0;
function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    memexId: 'mx-1',
    briefId: 'sb-1',
    actorUserId: CURRENT_USER,
    actorName: 'Barrie',
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: null,
    entity: 'decision',
    action: 'updated',
    narrative: 'Did a thing in b-1',
    payload: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function spec(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'sb-12',
    handle: 'spec-12',
    title: 'Auth migration',
    docType: 'spec',
    status: 'draft',
    parentDocId: null,
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sectionCount: 0,
    pausedAt: null,
    archivedAt: null,
    ...overrides,
  } as DocSummary;
}

function history(
  overrides: Partial<UsePulseHistoryResult> = {},
): UsePulseHistoryResult {
  return {
    rows: [],
    loading: false,
    error: null,
    hasMore: false,
    loadOlder: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

function present(overrides: Partial<PresentRow> = {}): PresentRow {
  return {
    memexId: 'mx-1',
    docId: 'sb-12',
    actorUserId: 'u-2',
    actorName: 'Barrie',
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: 'sess-1',
    lastSeenAt: new Date().toISOString(),
    source: 'heartbeat',
    ...overrides,
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

// Surface the current location search string so URL assertions are trivial.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderPulse() {
  return render(
    <MemoryRouter initialEntries={['/acme/main/pulse']}>
      <Routes>
        <Route
          path="/:namespace/:memex/pulse"
          element={
            <>
              <Pulse />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePulseStreamMock.mockReset();
  usePulseHistoryMock.mockReset();
  usePresenceMock.mockReset();
  fetchDocsMock.mockReset();
  useNeedsAttentionMock.mockReset();
  useTestSignalPulseMock.mockReset();

  usePulseStreamMock.mockReturnValue({ latest: null, status: 'connected' });
  useNeedsAttentionMock.mockReturnValue(EMPTY_ATTENTION);
  usePresenceMock.mockReturnValue({ rows: [], loading: false });
  fetchDocsMock.mockResolvedValue([]);
  usePulseHistoryMock.mockReturnValue(history());
  useTestSignalPulseMock.mockReturnValue({
    pulse: null,
    loading: false,
    error: null,
    fetchedAt: 0,
    refresh: vi.fn(),
  });
});

describe('Pulse page', () => {
  it('renders the feed and the needs-attention tray', async () => {
    usePulseHistoryMock.mockReturnValue(
      history({ rows: [row({ clientId: null, narrative: 'Updated dec-1 in b-1' })] }),
    );

    renderPulse();

    expect(await screen.findByTestId('activity-feed')).toBeInTheDocument();
    expect(screen.getByTestId('needs-attention-tray')).toBeInTheDocument();
    expect(screen.getByTestId('activity-row')).toBeInTheDocument();
  });

  it('shows the empty state when the history returns no rows', async () => {
    usePulseHistoryMock.mockReturnValue(history({ rows: [], loading: false }));

    renderPulse();

    expect(await screen.findByTestId('pulse-empty')).toBeInTheDocument();
  });

  describe('ScopeToggle', () => {
    it('defaults to "everyone" and applies no actor filter', async () => {
      renderPulse();

      // 'Everyone' segment is selected by default — the board is a shared view.
      const everyone = screen.getByRole('radio', { name: 'Everyone' });
      expect(everyone).toHaveAttribute('aria-checked', 'true');

      // Default scope applies no actorUserId filter (the whole Memex's activity).
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { actorUserId?: string };
        expect(last.actorUserId).toBeUndefined();
      });
    });

    it('toggling to "me" pins the actor filter + shows client chips; back to "everyone" clears them', async () => {
      // Seed a client-chip-eligible row so we can assert chips appear/disappear.
      usePulseHistoryMock.mockReturnValue(
        history({
          rows: [
            row({
              actorUserId: CURRENT_USER,
              clientId: 'claude-code',
              channel: 'mcp',
              createdAt: new Date().toISOString(),
            }),
          ],
        }),
      );

      renderPulse();

      // Default 'everyone' → no client chips.
      expect(screen.queryByRole('button', { name: /MCP/i })).toBeNull();

      // Toggle to 'me' → actorUserId pins to the current user and the chip shows.
      await userEvent.click(screen.getByRole('radio', { name: 'Just me' }));
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { actorUserId?: string };
        expect(last.actorUserId).toBe(CURRENT_USER);
      });
      expect(await screen.findByRole('button', { name: /MCP/i })).toBeInTheDocument();

      // Back to 'everyone' → filter lifts and chips hide again.
      await userEvent.click(screen.getByRole('radio', { name: 'Everyone' }));
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { actorUserId?: string };
        expect(last.actorUserId).toBeUndefined();
      });
      expect(screen.queryByRole('button', { name: /MCP/i })).toBeNull();
    });
  });

  describe('SpecPicker (dec-9)', () => {
    it('writes ?spec=spec-N and threads the spec id into the history filter', async () => {
      fetchDocsMock.mockResolvedValue([spec({ id: 'sb-12', handle: 'spec-12', title: 'Auth migration' })]);

      renderPulse();

      // Open the picker and choose the spec.
      const trigger = await screen.findByRole('button', { name: /Filtering activity to all Specs/i });
      await userEvent.click(trigger);
      const option = await screen.findByRole('option', { name: /Auth migration/i });
      await userEvent.click(option);

      // URL reflects ?spec=spec-12.
      await waitFor(() =>
        expect(screen.getByTestId('location-search')).toHaveTextContent('spec=spec-12'),
      );

      // The resolved spec id is passed down to usePulseHistory (the hook prop
      // is still named `briefId` for wire compatibility with the server).
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { briefId?: string };
        expect(last.briefId).toBe('sb-12');
      });
    });
  });

  describe('ClientChip filter (dec-7)', () => {
    it('sets the client filter on click and clears it on re-click', async () => {
      usePulseHistoryMock.mockReturnValue(
        history({
          rows: [
            row({
              actorUserId: CURRENT_USER,
              clientId: 'claude-code',
              channel: 'mcp',
              createdAt: new Date().toISOString(),
            }),
          ],
        }),
      );

      renderPulse();

      // Client chips render under 'me' scope only — switch to it first.
      await userEvent.click(screen.getByRole('radio', { name: 'Just me' }));

      const chip = await screen.findByRole('button', { name: /MCP/i });
      expect(chip).toHaveAttribute('aria-pressed', 'false');

      // Click → the clientId filter is applied to the history hook.
      await userEvent.click(chip);
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { clientId?: string };
        expect(last.clientId).toBe('claude-code');
      });
      expect(
        screen.getByRole('button', { name: /MCP/i }),
      ).toHaveAttribute('aria-pressed', 'true');

      // Re-click → the filter clears (clientId back to undefined).
      await userEvent.click(screen.getByRole('button', { name: /MCP/i }));
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { clientId?: string };
        expect(last.clientId).toBeUndefined();
      });
    });
  });

  describe('two-zone board (spec-122 ac-1)', () => {
    it('shows Working-now with active workers (name + spec + time-since) and What\'s-moving with state-changing rows only', async () => {
      tagAc(AC(1));
      // A spec the worker is on, so the doc-id → handle/title resolve.
      fetchDocsMock.mockResolvedValue([
        spec({ id: 'sb-12', handle: 'spec-12', title: 'Auth migration' }),
      ]);
      // One active worker present on that spec.
      usePresenceMock.mockReturnValue({
        rows: [
          present({
            docId: 'sb-12',
            actorName: 'Barrie',
            actorKind: 'mcp_agent',
            lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
          }),
        ],
        loading: false,
      });
      // History carries a MOVING row (decision updated) AND a read row (viewed) —
      // only the moving one should reach the What's-moving stream.
      usePulseHistoryMock.mockReturnValue(
        history({
          rows: [
            row({
              entity: 'decision',
              action: 'updated',
              narrative: 'Resolved dec-1 in spec-12',
              briefId: 'sb-12',
            }),
            row({
              entity: 'document',
              action: 'viewed',
              narrative: 'Viewed spec-12 Auth migration',
              briefId: 'sb-12',
            }),
          ],
        }),
      );

      renderPulse();

      // Working-now shows the active worker on their spec.
      const workingNow = await screen.findByTestId('working-now');
      // Working Now now unions presence with recent activity (spec-255), so the
      // present worker plus the decision-author both show — assert the present one.
      const worker = within(workingNow).getAllByTestId('working-now-worker')[0];
      expect(worker).toHaveTextContent('Barrie');
      expect(worker).toHaveTextContent('spec-12');
      // Time-since-last-beat is rendered (a <time> element).
      expect(within(worker).getByTestId('worker-last-beat').querySelector('time')).toBeTruthy();

      // What's-moving renders the state-changing row (its dec-1 handle is shown)…
      const feed = screen.getByTestId('activity-feed');
      expect(within(feed).getByText('dec-1')).toBeInTheDocument();
      // …but NOT the `viewed` read action. The viewed row's narrative
      // ("Viewed spec-12 …") never reaches the moving stream, so the only
      // activity-row in the feed is the moving one.
      expect(within(feed).getAllByTestId('activity-row')).toHaveLength(1);
      expect(within(feed).queryByText(/Viewed/)).toBeNull();
    });

    it('renders an empty Working-now zone when no one is present, keeping the tray', async () => {
      tagAc(AC(1));
      usePresenceMock.mockReturnValue({ rows: [], loading: false });
      renderPulse();
      expect(await screen.findByTestId('working-now-empty')).toBeInTheDocument();
      expect(screen.getByTestId('needs-attention-tray')).toBeInTheDocument();
    });
  });

  describe('presence-aware regression (spec-122 ac-2)', () => {
    it('mutes a regression on a worked spec and alarms on a quiet one', async () => {
      tagAc(AC(2));
      fetchDocsMock.mockResolvedValue([
        spec({ id: 'sb-worked', handle: 'spec-20', title: 'Worked' }),
        spec({ id: 'sb-quiet', handle: 'spec-21', title: 'Quiet' }),
      ]);
      // A worker is present ONLY on the worked spec.
      usePresenceMock.mockReturnValue({
        rows: [present({ docId: 'sb-worked', actorKind: 'mcp_agent' })],
        loading: false,
      });
      // Two regression rows: one on the worked spec, one on the quiet spec.
      usePulseHistoryMock.mockReturnValue(
        history({
          rows: [
            row({
              id: 'reg-worked',
              entity: 'document',
              action: 'updated',
              narrative: 'ac-3 went red in spec-20',
              briefId: 'sb-worked',
              clientId: null,
            }),
            row({
              id: 'reg-quiet',
              entity: 'document',
              action: 'updated',
              narrative: 'ac-4 went red in spec-21',
              briefId: 'sb-quiet',
              clientId: null,
            }),
          ],
        }),
      );

      renderPulse();

      await screen.findByTestId('activity-feed');
      const flags = screen.getAllByTestId('regressed-flag');
      expect(flags).toHaveLength(2);
      const muted = flags.map((f) => f.getAttribute('data-muted')).sort();
      // One muted (worked), one alarming (quiet) — they render differently.
      expect(muted).toEqual(['false', 'true']);
    });
  });
});

// Placate the unused-import linter if `within` ends up unused in some refactors.
void within;
