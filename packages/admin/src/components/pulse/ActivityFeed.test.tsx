import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ActivityFeed, groupRows } from './ActivityFeed';
import type { ActivityRow as ActivityRowData } from './types';

function renderFeed(props: Parameters<typeof ActivityFeed>[0]) {
  return render(
    <MemoryRouter>
      <ActivityFeed {...props} />
    </MemoryRouter>,
  );
}

let seq = 0;
function row(overrides: Partial<ActivityRowData> = {}): ActivityRowData {
  seq += 1;
  return {
    id: `row-${seq}`,
    memexId: 'mx-1',
    briefId: 'sb-1',
    actorUserId: 'u-1',
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

// Build an ISO timestamp `msAgo` milliseconds before now.
function ago(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('groupRows (exported helper)', () => {
  it('folds consecutive same-(clientId, briefId) rows within the burst window', () => {
    const rows = [
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(0) }),
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(30_000) }),
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(60_000) }),
    ];
    const groups = groupRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
  });

  it('does not group rows from different clients', () => {
    const rows = [
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(0) }),
      row({ clientId: 'other', briefId: 'sb-9', createdAt: ago(30_000) }),
    ];
    expect(groupRows(rows)).toHaveLength(2);
  });

  it('does not group rows on different briefs even from the same client', () => {
    const rows = [
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(0) }),
      row({ clientId: 'cc', briefId: 'sb-8', createdAt: ago(30_000) }),
    ];
    expect(groupRows(rows)).toHaveLength(2);
  });

  it('never groups rows with a null clientId (cannot attribute the burst)', () => {
    const rows = [
      row({ clientId: null, briefId: 'sb-9', createdAt: ago(0) }),
      row({ clientId: null, briefId: 'sb-9', createdAt: ago(30_000) }),
    ];
    expect(groupRows(rows)).toHaveLength(2);
  });

  it('breaks the group when the gap exceeds the burst window (2min)', () => {
    const rows = [
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(0) }),
      // 3 minutes later than the previous — outside the 2-minute window.
      row({ clientId: 'cc', briefId: 'sb-9', createdAt: ago(3 * 60 * 1000) }),
    ];
    expect(groupRows(rows)).toHaveLength(2);
  });
});

describe('ActivityFeed', () => {
  it('shows the skeleton when loading with zero rows', () => {
    renderFeed({ rows: [], status: 'connecting', loading: true });
    expect(screen.getByTestId('feed-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('pulse-empty')).toBeNull();
  });

  it('shows the empty state when not loading and there are zero rows', () => {
    renderFeed({ rows: [], status: 'connected', loading: false });
    expect(screen.getByTestId('pulse-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('feed-skeleton')).toBeNull();
  });

  it('renders rows (and no empty/skeleton state) when rows are present', () => {
    renderFeed({
      rows: [row({ clientId: null, narrative: 'Updated dec-1 in b-1' })],
      status: 'connected',
    });
    expect(screen.getByTestId('activity-row')).toBeInTheDocument();
    expect(screen.queryByTestId('pulse-empty')).toBeNull();
  });

  describe('status line', () => {
    it('reads "Live" when connected, with no reconnecting marker', () => {
      renderFeed({
        rows: [row({ clientId: null })],
        status: 'connected',
        eventsLastHour: 5,
      });
      expect(screen.getByText('Live')).toBeInTheDocument();
      expect(screen.getByText('5 events in last hour')).toBeInTheDocument();
      expect(screen.queryByTestId('pulse-reconnecting')).toBeNull();
    });

    it('marks pulse-reconnecting with "Reconnecting…" ONLY when the status is dead', () => {
      renderFeed({ rows: [row({ clientId: null })], status: 'dead' });
      const banner = screen.getByTestId('pulse-reconnecting');
      expect(banner).toHaveTextContent('Reconnecting…');
      // The "N events" tail is hidden while disconnected.
      expect(screen.queryByText(/events in last hour/)).toBeNull();
    });

    it('does NOT render pulse-reconnecting for the transient reconnecting status', () => {
      renderFeed({ rows: [row({ clientId: null })], status: 'reconnecting' });
      expect(screen.queryByTestId('pulse-reconnecting')).toBeNull();
      // Still labelled "Reconnecting…" but without the dead-state testid.
      expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    });
  });

  describe('event log header', () => {
    it('renders a single "Event Log" header above the rows, regardless of day spread', () => {
      renderFeed({
        rows: [
          row({ clientId: null, createdAt: ago(0) }),
          row({ clientId: null, createdAt: ago(2 * DAY) }),
        ],
        status: 'connected',
      });
      const headers = screen.getAllByTestId('event-log-header');
      // One header for the whole list — no per-day grouping.
      expect(headers).toHaveLength(1);
      expect(headers[0]).toHaveTextContent(/event log/i);
      expect(screen.queryByTestId('day-separator')).toBeNull();
    });
  });

  describe('backward paging', () => {
    it('renders [Load older] and calls onLoadOlder when hasMore is true', async () => {
      const onLoadOlder = vi.fn();
      renderFeed({
        rows: [row({ clientId: null })],
        status: 'connected',
        hasMore: true,
        onLoadOlder,
      });
      const button = screen.getByTestId('load-older');
      await userEvent.click(button);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    });

    it('omits [Load older] when hasMore is false', () => {
      renderFeed({ rows: [row({ clientId: null })], status: 'connected' });
      expect(screen.queryByTestId('load-older')).toBeNull();
    });
  });

  describe('burst grouping in the rendered feed', () => {
    it('folds consecutive same-client/same-spec rows into one collapsed group', async () => {
      renderFeed({
        rows: [
          row({ clientId: 'cc', briefId: 'sb-9', narrative: 'a in b-9', createdAt: ago(0) }),
          row({ clientId: 'cc', briefId: 'sb-9', narrative: 'b in b-9', createdAt: ago(20_000) }),
          row({ clientId: 'cc', briefId: 'sb-9', narrative: 'c in b-9', createdAt: ago(40_000) }),
        ],
        status: 'connected',
      });
      // Three sibling rows collapse to a single "3 actions" summary.
      const summary = screen.getByTestId('activity-row-group');
      expect(summary).toHaveTextContent('3 actions');
      expect(screen.queryByTestId('activity-row')).toBeNull();

      // Expanding the group reveals the member rows.
      await userEvent.click(summary);
      expect(screen.getAllByTestId('activity-row').length).toBe(3);
    });
  });
});
