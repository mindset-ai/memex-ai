import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { fetchWithRetry, fetchDoc, resolveComment, NotFoundError } from './client';

// spec-143 dec-4: Reject stamps resolution='rejected', Resolve stamps
// resolution='resolved'; the client resolveComment helper threads the optional
// resolution argument through to POST /api/comments/:id/resolve.
const AC_RESOLUTION_THREADING =
  'mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12';

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns response on first successful call', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await fetchWithRetry('/test');

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 502 and succeeds on second attempt', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const promise = fetchWithRetry('/test');
    await vi.advanceTimersByTimeAsync(1000); // first retry delay: 1000ms * 2^0
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds on second attempt', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const promise = fetchWithRetry('/test');
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after MAX_RETRIES and returns the 5xx response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('bad', { status: 502 }));

    const promise = fetchWithRetry('/test');
    await vi.advanceTimersByTimeAsync(1000); // retry 1
    await vi.advanceTimersByTimeAsync(2000); // retry 2
    const res = await promise;

    // After 2 retries (3 attempts total), returns the failing response
    expect(res.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error and succeeds on retry', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const promise = fetchWithRetry('/test');
    await vi.advanceTimersByTimeAsync(1000);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries exhausted on network error', async () => {
    // Use real timers with instant setTimeout to avoid fake-timer unhandled rejection issues
    vi.useRealTimers();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout;

    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchWithRetry('/test')).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(3);

    globalThis.setTimeout = origSetTimeout;
    vi.useFakeTimers(); // restore for remaining tests
  });

  it('does NOT retry on AbortError — re-throws immediately', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.mocked(fetch).mockRejectedValueOnce(abortError);

    await expect(fetchWithRetry('/test')).rejects.toThrow(abortError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('resolveComment (spec-143 dec-4 — resolution threading)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs { resolution: 'rejected' } when reject is threaded through", async () => {
    tagAc(AC_RESOLUTION_THREADING);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'c1', resolution: 'rejected' }), { status: 200 }),
    );

    await resolveComment('c1', 'rejected');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/comments/c1/resolve');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ resolution: 'rejected' }));
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it("POSTs { resolution: 'resolved' } when resolve is threaded through", async () => {
    tagAc(AC_RESOLUTION_THREADING);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'c1', resolution: 'resolved' }), { status: 200 }),
    );

    await resolveComment('c1', 'resolved');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ resolution: 'resolved' }));
  });

  it('omits the body (no resolution) when called without an argument', async () => {
    tagAc(AC_RESOLUTION_THREADING);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'c1', resolution: null }), { status: 200 }),
    );

    await resolveComment('c1');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.body).toBeUndefined();
  });
});

describe('fetchDoc', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NotFoundError on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(fetchDoc('missing-id')).rejects.toThrow(NotFoundError);
  });

  it('throws generic Error on other non-OK status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }));

    await expect(fetchDoc('some-id')).rejects.toThrow('Failed to fetch document: 500');
  });
});
