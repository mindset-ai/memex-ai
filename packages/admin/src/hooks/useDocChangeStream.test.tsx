import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('../api/http', () => ({
  tenantBase: () => '/api/tenant',
  BASE_URL: '/api',
}));

// eslint-disable-next-line import/first
import { useDocChangeStream } from './useDocChangeStream';

interface MockStream {
  push: (chunk: string) => void;
  close: () => void;
  response: Response;
  closed: boolean;
}

function makeMockStream(): MockStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const m: MockStream = {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    push: (chunk: string) => {
      controller?.enqueue(new TextEncoder().encode(chunk));
    },
    close: () => {
      if (m.closed) return;
      m.closed = true;
      try {
        controller?.close();
      } catch {
        // already closed
      }
    },
    closed: false,
  };
  return m;
}

describe('useDocChangeStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let streams: MockStream[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    streams = [];
    fetchMock = vi.fn().mockImplementation(() => {
      const s = makeMockStream();
      streams.push(s);
      return Promise.resolve(s.response);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    for (const s of streams) s.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does NOT call onEvent on the initial connection (consumer already fetched on mount)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    // Give the post-connect synchronous path a tick + the 200ms debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('calls onEvent (debounced) when a doc_change event arrives', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: doc_change\ndata: {}\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('debounces multiple rapid doc_change events into a single onEvent', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: doc_change\ndata: {}\n\n');
    streams[0].push('event: doc_change\ndata: {}\n\n');
    streams[0].push('event: doc_change\ndata: {}\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onEvent for non-doc_change event types (e.g. keepalive)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: keepalive\ndata: \n\n');
    streams[0].push('event: ready\ndata: \n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('triggers a refetch when the SSE stream re-establishes, even with zero events on the new connection (doc-16 dec-4)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    // Server closes the stream — simulates a restart or transient network loss.
    streams[0].close();

    // Hook backoff is 1s before the first reconnect attempt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await waitFor(() => expect(streams.length).toBe(2));

    // No event has been pushed on stream 2 — but the hook MUST refetch anyway.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('per-Memex stream (docId=null) also refetches on reconnect', async () => {
    const onEvent = vi.fn();
    renderHook(() => useDocChangeStream(null, onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].close();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    await waitFor(() => expect(streams.length).toBe(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  // ── Connection sharing (spec-118 fix) ──────────────────────────────────────
  // The Spec page mounts this hook from several components on the SAME scope.
  // They MUST multiplex onto one streaming fetch — otherwise the long-lived
  // streams saturate the browser's per-origin connection pool (HTTP/1.1: 6) and
  // starve mutations + refetches, which is what made the role/assign controls
  // silently do nothing.

  it('shares ONE connection across multiple subscribers on the same scope', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    renderHook(() => useDocChangeStream('doc-1', a));
    renderHook(() => useDocChangeStream('doc-1', b));
    renderHook(() => useDocChangeStream('doc-1', c));

    // Three subscribers, ONE underlying fetch.
    await waitFor(() => expect(streams.length).toBe(1));

    // A single doc_change fans out to every subscriber.
    streams[0].push('event: doc_change\ndata: {}\n\n');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('opens SEPARATE connections for different stream scopes (distinct docIds)', async () => {
    renderHook(() => useDocChangeStream('doc-1', vi.fn()));
    renderHook(() => useDocChangeStream('doc-2', vi.fn()));
    await waitFor(() => expect(streams.length).toBe(2));
  });

  it('keeps the shared connection open until the LAST subscriber unmounts', async () => {
    const first = renderHook(() => useDocChangeStream('doc-1', vi.fn()));
    const second = renderHook(() => useDocChangeStream('doc-1', vi.fn()));
    await waitFor(() => expect(streams.length).toBe(1));

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    // One of two leaves — connection must stay live for the remaining subscriber.
    first.unmount();
    expect(signal.aborted).toBe(false);

    // Last subscriber leaves — now the shared fetch is aborted.
    second.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('aborts the in-flight fetch and clears debounce on unmount (no orphan callbacks)', async () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useDocChangeStream('doc-1', onEvent));

    await waitFor(() => expect(streams.length).toBe(1));

    // Push an event but unmount before the debounce window expires.
    streams[0].push('event: doc_change\ndata: {}\n\n');
    unmount();

    // Verify the abort signal was tripped on the fetch call.
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(true);

    // Wait past the debounce window — the cleared timeout means no onEvent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();

    // And no new fetch happens after unmount.
    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
