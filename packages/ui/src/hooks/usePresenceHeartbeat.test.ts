// spec-122 t-7 (dec-4, ac-16) — the browser heartbeat hook.
//
//   ac-16  while the tab is VISIBLE, the hook POSTs the spec ref (and ONLY the
//          spec ref — no document content) every ~15s; while the tab is HIDDEN
//          it sends nothing.
//
// We mock the http layer so the assertions are about WHAT the hook sends and
// WHEN, not the retry/transport mechanics.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const fetchWithRetry = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
const tenantBase = vi.fn(() => '/api/ns/mx');

vi.mock('../api/http', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
  tenantBase: () => tenantBase(),
}));

import { usePresenceHeartbeat } from './usePresenceHeartbeat';

const SPEC_REF = 'mindset-prod/memex-building-itself/specs/spec-122';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

describe('usePresenceHeartbeat [spec-122 t-7]', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchWithRetry.mockClear();
    tenantBase.mockClear();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('ac-16: POSTs the spec ref (and nothing else) every ~15s while visible', () => {
    renderHook(() => usePresenceHeartbeat(SPEC_REF));

    // First beat fires immediately on mount.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);

    const [url, init] = fetchWithRetry.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ns/mx/presence');
    expect(init.method).toBe('POST');

    // The payload carries ONLY the spec ref — NO document content.
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ ref: SPEC_REF });
    expect(Object.keys(body)).toEqual(['ref']);

    // Advance ~15s → a second beat.
    vi.advanceTimersByTime(15_000);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);

    // Another interval → a third.
    vi.advanceTimersByTime(15_000);
    expect(fetchWithRetry).toHaveBeenCalledTimes(3);
  });

  it('ac-16: stops beating while the tab is hidden, resumes when visible', () => {
    renderHook(() => usePresenceHeartbeat(SPEC_REF));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1); // immediate beat

    // Hide the tab + fire visibilitychange → the interval is torn down.
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(60_000);
    // No further POSTs while hidden.
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);

    // Resume when the tab becomes visible again.
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    // Resuming beats immediately.
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15_000);
    expect(fetchWithRetry).toHaveBeenCalledTimes(3);
  });

  it('ac-16: does nothing without a spec ref', () => {
    renderHook(() => usePresenceHeartbeat(null));
    vi.advanceTimersByTime(60_000);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
