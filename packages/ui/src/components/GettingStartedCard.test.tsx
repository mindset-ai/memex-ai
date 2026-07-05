import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-460/acs/ac-${n}`;

// Mutable journey state the mocked cache/fetch return, flipped per test.
const { journey, track, fetchSpy } = vi.hoisted(() => ({
  journey: {
    value: null as null | { milestones: Record<string, boolean> },
    // When set, the mount fetch returns this promise instead of resolving
    // immediately — lets a test hold the card in its pre-resolve (no-flash) state.
    pending: null as null | Promise<{ milestones: Record<string, boolean> }>,
  },
  track: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock('../journeys/journeyStateCache', () => ({
  getCachedJourneyState: () => journey.value,
}));

vi.mock('../api/journey', () => ({
  fetchJourneyStateApi: (...args: unknown[]) => {
    fetchSpy(...args);
    return journey.pending ?? Promise.resolve(journey.value ?? { milestones: { mcpConnected: false } });
  },
}));

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

import { GettingStartedCard } from './GettingStartedCard';

const USER = 'user-1';

function seedCache(milestones: Record<string, boolean>) {
  journey.value = { milestones };
}

beforeEach(() => {
  track.mockClear();
  fetchSpy.mockClear();
  journey.value = null;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('spec-460: GettingStartedCard', () => {
  it('renders both rows for a non-connected, non-dismissed user (ac-10)', () => {
    tagAc(AC(10));
    seedCache({ mcpConnected: false });
    render(<GettingStartedCard userId={USER} />);

    expect(screen.getByTestId('getting-started-card')).toBeInTheDocument();
    expect(screen.getByTestId('getting-started-app-row')).toBeInTheDocument();
    expect(screen.getByTestId('getting-started-call-row')).toBeInTheDocument();
    // Links point at the marketing pages with the sidebar-card source (ac-20:
    // the booking row uses the neutral alias + src=sidebar-card, new tab, noopener).
    tagAc(AC(20));
    expect(screen.getByTestId('getting-started-app-row')).toHaveAttribute(
      'href',
      'https://www.memex.ai/download?src=sidebar-card',
    );
    const callLink = screen.getByTestId('getting-started-call-row').querySelector('a')!;
    expect(callLink).toHaveAttribute('href', 'https://www.memex.ai/book-a-call?src=sidebar-card');
    expect(callLink).toHaveAttribute('target', '_blank');
    expect(callLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides the desktop-app row when MCP is connected, regardless of dismissal (ac-11)', () => {
    tagAc(AC(11));
    seedCache({ mcpConnected: true });
    render(<GettingStartedCard userId={USER} />);

    expect(screen.queryByTestId('getting-started-app-row')).not.toBeInTheDocument();
    // Call row still there (not dismissed) → card still visible.
    expect(screen.getByTestId('getting-started-call-row')).toBeInTheDocument();
    // The retirement signal fired (ac-21: getting_started.app_row_retired).
    tagAc(AC(21));
    tagAc(AC(7));
    expect(track.mock.calls.filter((c) => c[0] === 'getting_started.app_row_retired')).toHaveLength(1);
  });

  it('unmounts the whole card once every row is retired or dismissed (ac-12)', () => {
    tagAc(AC(12));
    // Connected (app row retired) AND call previously dismissed → nothing to show.
    seedCache({ mcpConnected: true });
    localStorage.setItem(`memex.gettingStarted.callDismissed:${USER}`, '1');
    render(<GettingStartedCard userId={USER} />);

    expect(screen.queryByTestId('getting-started-card')).not.toBeInTheDocument();
  });

  it('dismisses the call row on × with no network, and hasSpec has no effect (ac-13)', () => {
    tagAc(AC(13));
    // hasSpec true must NOT retire the call row (dec-8 dismiss-only).
    seedCache({ mcpConnected: false, hasSpec: true });
    render(<GettingStartedCard userId={USER} />);

    expect(screen.getByTestId('getting-started-call-row')).toBeInTheDocument(); // hasSpec ignored
    fetchSpy.mockClear();

    fireEvent.click(screen.getByTestId('getting-started-dismiss-call'));

    expect(screen.queryByTestId('getting-started-call-row')).not.toBeInTheDocument();
    expect(track.mock.calls.filter((c) => c[0] === 'getting_started.call_row_dismissed')).toHaveLength(1);
    // No network write on dismiss (cache was seeded, so no mount fetch either).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('persists dismissal across a remount via user-scoped localStorage, and syncs cross-tab (ac-14)', () => {
    tagAc(AC(14));
    seedCache({ mcpConnected: false });

    // Dismiss the call row, then remount (simulates a reload): it stays gone.
    const r1 = render(<GettingStartedCard userId={USER} />);
    fireEvent.click(within(r1.container).getByTestId('getting-started-dismiss-call'));
    expect(localStorage.getItem(`memex.gettingStarted.callDismissed:${USER}`)).toBe('1');
    r1.unmount();

    const r2 = render(<GettingStartedCard userId={USER} />);
    expect(within(r2.container).queryByTestId('getting-started-call-row')).not.toBeInTheDocument();
    r2.unmount();

    // A DIFFERENT user on the same device is unaffected (scoped key).
    const r3 = render(<GettingStartedCard userId="other-user" />);
    expect(within(r3.container).getByTestId('getting-started-call-row')).toBeInTheDocument();
    r3.unmount();

    // Cross-tab: another tab dismisses the whole card → storage event unmounts it here.
    // (USER still shows the app row, so the card is visible until the card-level dismiss.)
    const r4 = render(<GettingStartedCard userId={USER} />);
    expect(within(r4.container).getByTestId('getting-started-card')).toBeInTheDocument();
    act(() => {
      localStorage.setItem(`memex.gettingStarted.cardDismissed:${USER}`, '1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: `memex.gettingStarted.cardDismissed:${USER}` }),
      );
    });
    expect(within(r4.container).queryByTestId('getting-started-card')).not.toBeInTheDocument();
  });

  it('renders nothing until the journey signal resolves (no-flash guard)', async () => {
    // Cold: no cache, and the mount fetch is held pending. The card must not paint
    // until the signal resolves (never flash a card that might then vanish).
    journey.value = null;
    let resolveFetch: (v: { milestones: Record<string, boolean> }) => void = () => {};
    journey.pending = new Promise((r) => {
      resolveFetch = r;
    });

    render(<GettingStartedCard userId={USER} />);
    expect(screen.queryByTestId('getting-started-card')).not.toBeInTheDocument();

    await act(async () => {
      resolveFetch({ milestones: { mcpConnected: false } });
      await journey.pending;
    });
    expect(screen.getByTestId('getting-started-card')).toBeInTheDocument();
    journey.pending = null;
  });
});
