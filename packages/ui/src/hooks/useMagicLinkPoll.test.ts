// spec-304 t-40 (ac-30) — originating-session magic-link polling hook.
//
// These tests prove the WEB-SIDE mechanism behind ac-30: a magic-link login that
// completes in the originating tab/webview via polling. The cross-platform
// in-webview runtime leg of ac-30 (macOS/WKWebView + Windows/WebView2) is the
// manual sign-off part — see t-41.
//
// We mock only `magicLinkStatusApi` (the network) and keep the real
// `NotFoundError` so the 404 branch is exercised against the actual error class
// the api-client throws. Fake timers drive the interval / TTL deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from '../api/client';

const magicLinkStatusApi = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    magicLinkStatusApi: (...args: unknown[]) => magicLinkStatusApi(...args),
  };
});

import { useMagicLinkPoll, MAGIC_LINK_POLL_INTERVAL_MS, MAGIC_LINK_POLL_TTL_MS } from './useMagicLinkPoll';
import { NotFoundError } from '../api/client';

const AC = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-30';
const REQUEST_ID = 'lr_abc123';

function fakeSession(): SessionPayload {
  return {
    user: { id: 'u-1', email: 'a@b.com', name: 'A', status: 'active', emailVerified: true },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures: [],
    token: 'jwt-from-poll',
  };
}

// Flush the microtask queue so an awaited mocked fetch resolves before we assert.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMagicLinkPoll [spec-304 t-40 / ac-30]', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    magicLinkStatusApi.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts polling the surrogate as soon as a loginRequestId is present', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: false });

    renderHook(() => useMagicLinkPoll(REQUEST_ID, vi.fn()));

    // An immediate poll fires on mount (so a link verified <2.5s lands fast).
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledWith(REQUEST_ID);
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(1);
  });

  it('does NOT poll when loginRequestId is null', () => {
    tagAc(AC);
    renderHook(() => useMagicLinkPoll(null, vi.fn()));
    expect(magicLinkStatusApi).not.toHaveBeenCalled();
  });

  it('pending then verified → adopts the session exactly once and stops polling', async () => {
    tagAc(AC);
    const session = fakeSession();
    magicLinkStatusApi
      .mockResolvedValueOnce({ verified: false, expired: false }) // immediate poll
      .mockResolvedValueOnce({ verified: true, ...session }) // next tick → verified
      .mockResolvedValue({ verified: false, expired: false }); // any later poll (should not happen)

    const onVerified = vi.fn();
    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, onVerified));

    await flush();
    expect(result.current).toBe('polling');
    expect(onVerified).not.toHaveBeenCalled();

    // Advance one interval → the verified poll resolves.
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS);
    });
    await flush();

    expect(result.current).toBe('verified');
    // Adoption happens through the passed-down callback, with the session minus
    // the `verified` discriminator (the same payload /consume returns).
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt-from-poll' }));
    expect(onVerified.mock.calls[0][0]).not.toHaveProperty('verified');

    // Single-shot: no further polls fire after verified — advancing time is a no-op.
    const callsAtVerify = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 4);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(callsAtVerify);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('verified is handled single-shot — onVerified never fires twice even if a poll is mid-flight', async () => {
    tagAc(AC);
    const session = fakeSession();
    // Every call returns verified; a correct single-shot loop must still only
    // adopt once and stop, never re-handing the (now-deleted) surrogate.
    magicLinkStatusApi.mockResolvedValue({ verified: true, ...session });

    const onVerified = vi.fn();
    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, onVerified));

    await flush();
    expect(result.current).toBe('verified');

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 3);
    });
    await flush();

    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('expired surrogate → phase becomes expired and polling stops', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: true });

    const onVerified = vi.fn();
    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, onVerified));

    await flush();
    expect(result.current).toBe('expired');
    expect(onVerified).not.toHaveBeenCalled();

    const calls = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls); // stopped
  });

  it('404 (unknown / already picked-up surrogate) → expired phase, polling stops', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockRejectedValue(new NotFoundError('Unknown login request'));

    const onVerified = vi.fn();
    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, onVerified));

    await flush();
    expect(result.current).toBe('expired');

    const calls = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls);
  });

  it('a transient (non-404) network error does NOT kill the loop — it keeps polling', async () => {
    tagAc(AC);
    magicLinkStatusApi
      .mockRejectedValueOnce(new Error('network blip')) // immediate poll fails
      .mockResolvedValue({ verified: false, expired: false }); // recovers

    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, vi.fn()));

    await flush();
    expect(result.current).toBe('polling');

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS);
    });
    await flush();
    expect(magicLinkStatusApi.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current).toBe('polling');
  });

  it('stops after the 15-minute TTL even if the surrogate never resolves', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: false });

    const { result } = renderHook(() => useMagicLinkPoll(REQUEST_ID, vi.fn()));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_TTL_MS);
    });
    await flush();
    expect(result.current).toBe('expired');

    const calls = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 5);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls); // no polls after TTL stop
  });

  it('clears the interval on unmount — no poll fires after teardown', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: false });

    const { unmount } = renderHook(() => useMagicLinkPoll(REQUEST_ID, vi.fn()));
    await flush();
    const calls = magicLinkStatusApi.mock.calls.length;

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 5);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls);
  });
});
