import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import type { DocSummary } from '../api/types';
import type { ActivityRow } from '../components/pulse/types';
import type { UsePulseHistoryResult } from '../hooks/usePulseHistory';

const CURRENT_USER = 'u-1';

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
  fetchDocsMock.mockReset();
  useNeedsAttentionMock.mockReset();

  usePulseStreamMock.mockReturnValue({ latest: null, status: 'connected' });
  useNeedsAttentionMock.mockReturnValue(EMPTY_ATTENTION);
  fetchDocsMock.mockResolvedValue([]);
  usePulseHistoryMock.mockReturnValue(history());
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

  describe('ScopeToggle (dec-7)', () => {
    it('defaults to "me" and pins the history filter to the current user', async () => {
      renderPulse();

      // 'me' segment is selected by default.
      const me = screen.getByRole('radio', { name: 'Just me' });
      expect(me).toHaveAttribute('aria-checked', 'true');

      // Under 'me', usePulseHistory is called with actorUserId = current user.
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { actorUserId?: string };
        expect(last.actorUserId).toBe(CURRENT_USER);
      });
    });

    it('clears the actorUserId filter when toggled to "everyone"', async () => {
      // Seed a client-chip-eligible row so we can also assert chips disappear.
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

      // The active-client chip is visible under 'me'.
      expect(
        await screen.findByRole('button', { name: /MCP/i }),
      ).toBeInTheDocument();

      await userEvent.click(screen.getByRole('radio', { name: 'Everyone' }));

      // actorUserId lifts to undefined under 'everyone'.
      await waitFor(() => {
        const calls = usePulseHistoryMock.mock.calls;
        const last = calls[calls.length - 1][0] as { actorUserId?: string };
        expect(last.actorUserId).toBeUndefined();
      });

      // Client chips are hidden outside 'me'.
      expect(
        screen.queryByRole('button', { name: /MCP/i }),
      ).toBeNull();
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
});

// Placate the unused-import linter if `within` ends up unused in some refactors.
void within;
