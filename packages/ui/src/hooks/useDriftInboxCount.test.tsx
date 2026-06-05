import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

// The count fetch resolves the tenant from the URL path inside `fetchDriftInbox`
// (via `tBase()`), so we don't exercise the real fetch here — we assert the hook
// re-invokes it on a Memex switch (client-side navigation) and reflects the new
// tenant's count. Each tenant pathname maps to a distinct item list.
const driftByTenant: Record<string, number> = {
  '/barrie/personal/standards': 3,
  '/main/main/standards': 0,
};

let lastFetchPath: string | null = null;

vi.mock('../api/client', () => ({
  fetchDriftInbox: vi.fn(() => {
    // The hook itself doesn't pass the path; the real client reads
    // window.location. We mirror that here so the mock returns the count for
    // whatever route the hook is currently mounted under.
    const path = lastFetchPath ?? window.location.pathname;
    const n = driftByTenant[path] ?? 0;
    return Promise.resolve(Array.from({ length: n }, (_, i) => ({ commentId: `c-${i}` })));
  }),
}));

// SSE live-update is covered by useDocChangeStream's own suite; stub it to a
// no-op so this test isolates the tenant-scoping behaviour.
vi.mock('./useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

// eslint-disable-next-line import/first
import { useDriftInboxCount } from './useDriftInboxCount';
// eslint-disable-next-line import/first
import { fetchDriftInbox } from '../api/client';

const fetchMock = vi.mocked(fetchDriftInbox);

/**
 * Renders the hook under a MemoryRouter at `initialPath` and hands back a
 * `navigate` fn so the test can simulate the Memex switcher (which uses
 * client-side `navigate()`, NOT a full reload — AppShell stays mounted).
 */
function renderAtTenant(initialPath: string) {
  let navigateFn: ((to: string) => void) | null = null;
  function Capture() {
    navigateFn = useNavigate();
    return null;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Capture />
      {children}
    </MemoryRouter>
  );
  lastFetchPath = initialPath;
  const utils = renderHook(() => useDriftInboxCount(), { wrapper });
  return {
    ...utils,
    navigate: (to: string) => {
      // Keep the mock's tenant-aware return in lock-step with the route.
      lastFetchPath = to;
      act(() => navigateFn?.(to));
    },
  };
}

describe('useDriftInboxCount', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    lastFetchPath = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the count for the current tenant on mount', async () => {
    const { result } = renderAtTenant('/barrie/personal/standards');
    await waitFor(() => expect(result.current).toBe(3));
    expect(fetchMock).toHaveBeenCalled();
  });

  it('re-fetches and updates the count when the active Memex changes', async () => {
    const { result, navigate } = renderAtTenant('/barrie/personal/standards');
    await waitFor(() => expect(result.current).toBe(3));

    const callsBefore = fetchMock.mock.calls.length;

    // Simulate the Memex switcher: personal (3 drift) → Main (0 drift).
    navigate('/main/main/standards');

    // The badge MUST reflect the newly-selected Memex, not the stale 3.
    await waitFor(() => expect(result.current).toBe(0));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not fetch when disabled (e.g. on doc pages where the sidebar is hidden)', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/barrie/personal/specs/spec-1']}>{children}</MemoryRouter>
    );
    const { result } = renderHook(() => useDriftInboxCount(false), { wrapper });
    // Give any effect a chance to run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
