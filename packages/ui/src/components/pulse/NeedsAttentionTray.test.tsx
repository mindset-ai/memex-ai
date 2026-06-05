import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AttentionSlice,
  NeedsAttentionItem,
  UseNeedsAttentionResult,
} from './tray/useNeedsAttention';

// Mock the data hook so the tray is deterministic — no real fetch / tenant
// context needed. Each test sets the next return value.
const useNeedsAttentionMock = vi.hoisted(() => vi.fn());
vi.mock('./tray/useNeedsAttention', () => ({
  useNeedsAttention: (briefId?: string) => useNeedsAttentionMock(briefId),
}));

import { NeedsAttentionTray } from './NeedsAttentionTray';

function item(overrides: Partial<NeedsAttentionItem> = {}): NeedsAttentionItem {
  return {
    id: 'i-1',
    handle: 'dec-1',
    specHandle: 'b-1',
    briefId: 'sb-1',
    title: 'A pending decision',
    ...overrides,
  };
}

function slice(count: number, items: NeedsAttentionItem[] = []): AttentionSlice {
  return { count, items };
}

function attention(
  overrides: Partial<UseNeedsAttentionResult> = {},
): UseNeedsAttentionResult {
  return {
    unresolvedDecisions: slice(0),
    openQuestions: slice(0),
    driftSignals: slice(0),
    blockedTasks: slice(0),
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

function renderTray(props: Parameters<typeof NeedsAttentionTray>[0] = {}) {
  return render(
    <MemoryRouter>
      <NeedsAttentionTray {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useNeedsAttentionMock.mockReset();
});

describe('NeedsAttentionTray', () => {
  it('renders the tray with all four tiles when data has resolved', () => {
    useNeedsAttentionMock.mockReturnValue(
      attention({
        unresolvedDecisions: slice(2, [
          item({ id: 'd-1', handle: 'dec-3', title: 'Pick an auth lib' }),
        ]),
      }),
    );

    renderTray();

    expect(screen.getByTestId('needs-attention-tray')).toBeInTheDocument();
    expect(screen.getByTestId('tray-tile-decisions')).toBeInTheDocument();
    expect(screen.getByTestId('tray-tile-questions')).toBeInTheDocument();
    expect(screen.getByTestId('tray-tile-drift')).toBeInTheDocument();
    expect(screen.getByTestId('tray-tile-blocked-tasks')).toBeInTheDocument();
  });

  it('renders a tile count badge and its recent items', () => {
    useNeedsAttentionMock.mockReturnValue(
      attention({
        unresolvedDecisions: slice(2, [
          item({ id: 'd-1', handle: 'dec-3', title: 'Pick an auth lib' }),
          item({ id: 'd-2', handle: 'dec-4', title: 'Pick a queue' }),
        ]),
      }),
    );

    renderTray();

    const tile = screen.getByTestId('tray-tile-decisions');
    // Count badge reflects the slice count.
    expect(within(tile).getByTestId('tray-count')).toHaveTextContent('2');
    // The recent items render their titles.
    expect(within(tile).getByText('Pick an auth lib')).toBeInTheDocument();
    expect(within(tile).getByText('Pick a queue')).toBeInTheDocument();
    // No empty-state copy when the tile has items.
    expect(within(tile).queryByTestId('tray-tile-empty')).toBeNull();
  });

  it('shows tray-tile-empty and NO tray-count for a zero-count tile', () => {
    useNeedsAttentionMock.mockReturnValue(
      attention({
        // Decisions has items so the column isn't entirely empty, but drift is 0.
        unresolvedDecisions: slice(1, [item({ id: 'd-1' })]),
        driftSignals: slice(0),
      }),
    );

    renderTray();

    const driftTile = screen.getByTestId('tray-tile-drift');
    expect(within(driftTile).getByTestId('tray-tile-empty')).toBeInTheDocument();
    // testid fact: tray-count is ABSENT when count === 0.
    expect(within(driftTile).queryByTestId('tray-count')).toBeNull();
  });

  it('shows one skeleton per tile on first paint (loading with every slice empty)', () => {
    useNeedsAttentionMock.mockReturnValue(attention({ loading: true }));

    renderTray();

    // One shimmer tile per registered tile (4), and none of the real tiles yet.
    expect(screen.getAllByTestId('tray-tile-skeleton')).toHaveLength(4);
    expect(screen.queryByTestId('tray-tile-decisions')).toBeNull();
    // No "Refreshing…" line during first paint.
    expect(screen.queryByTestId('tray-loading')).toBeNull();
  });

  it('keeps real tiles and shows the "Refreshing…" line on a refresh (loading WITH data)', () => {
    useNeedsAttentionMock.mockReturnValue(
      attention({
        loading: true,
        unresolvedDecisions: slice(1, [item({ id: 'd-1' })]),
      }),
    );

    renderTray();

    // Data is present, so the real tiles render (not skeletons) plus the line.
    expect(screen.getByTestId('tray-tile-decisions')).toBeInTheDocument();
    expect(screen.queryByTestId('tray-tile-skeleton')).toBeNull();
    expect(screen.getByTestId('tray-loading')).toHaveTextContent('Refreshing…');
  });

  it('surfaces the hook error message', () => {
    useNeedsAttentionMock.mockReturnValue(
      attention({ error: 'Boom: failed to load' }),
    );

    renderTray();

    expect(screen.getByText('Boom: failed to load')).toBeInTheDocument();
  });

  it('threads the briefId prop through to the hook (dec-9 scope)', () => {
    useNeedsAttentionMock.mockReturnValue(attention());
    renderTray({ briefId: 'sb-42' });
    expect(useNeedsAttentionMock).toHaveBeenCalledWith('sb-42');
  });
});
