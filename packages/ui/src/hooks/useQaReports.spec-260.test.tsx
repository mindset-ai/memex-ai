// spec-260 t-8 — the unread-badge hook (dec-6): count fetch, live SSE refresh,
// zero-on-view, and the keyset Load More maths of the feed hook. api/http is
// stubbed (the hook-test convention), so tenant resolution and retries are out
// of scope here — the server integration tests own the endpoint behaviour.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../api/http', () => ({
  tenantBase: () => '/api/acme/main',
  fetchWithRetry: (...a: unknown[]) => fetchMock(...a),
}));

// Capture the SSE subscription so tests can fire a live event.
const streamCallbacks = vi.hoisted(() => ({ current: [] as Array<() => void> }));
vi.mock('./useDocChangeStream', () => ({
  useDocChangeStream: (_docId: string | null, onEvent: () => void) => {
    streamCallbacks.current.push(onEvent);
  },
}));

import {
  QA_REPORTS_VIEWED_EVENT,
  recordQaReportsView,
  useQaReportsFeed,
  useQaReportsUnreadCount,
} from './useQaReports';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/acme/main/qa-reports']}>{children}</MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  streamCallbacks.current = [];
});

describe('useQaReportsUnreadCount (dec-6 badge)', () => {
  it('ac-10: fetches the per-user unread count and zeroes on the view broadcast', async () => {
    tagAc(AC(10));
    fetchMock.mockResolvedValue(jsonResponse({ count: 4 }));

    const { result } = renderHook(() => useQaReportsUnreadCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(4));
    expect(fetchMock).toHaveBeenCalledWith('/api/acme/main/qa-reports/unread');

    // The page records a view → the badge zeroes immediately (same tab),
    // without waiting for a server round-trip.
    act(() => {
      window.dispatchEvent(new Event(QA_REPORTS_VIEWED_EVENT));
    });
    expect(result.current).toBe(0);
  });

  it('ac-10/ac-20: a live bus event refreshes the count without a reload', async () => {
    tagAc(AC(10));
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0 }));

    const { result } = renderHook(() => useQaReportsUnreadCount(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A new report rides the std-8 bus → the badge refetches and increments.
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1 }));
    act(() => {
      streamCallbacks.current.forEach((cb) => cb());
    });
    await waitFor(() => expect(result.current).toBe(1));
  });

  it('errors yield 0 — the badge hides rather than erroring in the chrome', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useQaReportsUnreadCount(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });
});

describe('recordQaReportsView', () => {
  it('ac-10: POSTs the view marker and broadcasts the zeroing event', async () => {
    tagAc(AC(10));
    fetchMock.mockResolvedValue(jsonResponse({ lastViewedAt: '2026-06-12T00:00:00Z' }));
    const heard = vi.fn();
    window.addEventListener(QA_REPORTS_VIEWED_EVENT, heard);
    try {
      await recordQaReportsView();
      expect(fetchMock).toHaveBeenCalledWith('/api/acme/main/qa-reports/view', { method: 'POST' });
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(QA_REPORTS_VIEWED_EVENT, heard);
    }
  });
});

describe('useQaReportsFeed (dec-5 keyset Load More)', () => {
  it('ac-8: first page then loadOlder passes the oldest row createdAt as `since`', async () => {
    tagAc(AC(8));
    const page1 = [
      { id: 'r-2', createdAt: '2026-06-02T00:00:00Z' },
      { id: 'r-1', createdAt: '2026-06-01T00:00:00Z' },
    ];
    const page2 = [{ id: 'r-0', createdAt: '2026-05-30T00:00:00Z' }];
    fetchMock.mockResolvedValueOnce(jsonResponse(page1));

    const { result } = renderHook(() => useQaReportsFeed(2), { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    // A full page (length == limit) keeps Load More enabled.
    expect(result.current.hasMore).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse(page2));
    await act(async () => {
      await result.current.loadOlder();
    });

    // The keyset boundary is the OLDEST loaded row's createdAt.
    const lastCall = fetchMock.mock.calls.at(-1)![0] as string;
    expect(lastCall).toContain('since=2026-06-01T00%3A00%3A00Z');
    expect(result.current.rows.map((r) => r.id)).toEqual(['r-2', 'r-1', 'r-0']);
    // A short page means the tail was reached.
    expect(result.current.hasMore).toBe(false);
  });
});
