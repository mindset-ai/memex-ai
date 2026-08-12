import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('../api/http', () => ({
  BASE_URL: '/api',
}));

// eslint-disable-next-line import/first
import { useUserChangeStream, useUserChangeStreamWithToken } from './useUserChangeStream';

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

describe('useUserChangeStream', () => {
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
    renderHook(() => useUserChangeStream(onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('calls onEvent (debounced) when a user_change event arrives', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: user_change\ndata: {"entity":"mcp_token"}\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onEvent for non-user_change event types (e.g. keepalive)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: keepalive\ndata: \n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('triggers a refetch when the SSE stream re-establishes (doc-16 dec-4)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent));

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

  // ── entityFilter stays a per-subscriber concern ────────────────────────────
  // It must NOT become a property of the shared connection: two subscribers with
  // different filters share one stream, so filtering happens at dispatch.

  it('respects entityFilter — an unlisted entity does not fire the callback', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent, ['mcp_token']));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: user_change\ndata: {"entity":"user_slack_token"}\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fires when an event with no readable entity arrives (permissive contract)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent, ['mcp_token']));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: user_change\ndata: not-json\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('fires a filtered subscriber on RECONNECT regardless of its filter (dec-4)', async () => {
    const onEvent = vi.fn();
    renderHook(() => useUserChangeStream(onEvent, ['mcp_token']));

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

  // ── Connection sharing ─────────────────────────────────────────────────────
  // There is exactly ONE per-user channel, so every call site is on the same
  // scope. They MUST multiplex onto one streaming fetch: a never-closing stream
  // per call site saturates the browser's per-origin pool (HTTP/1.1: 6) and
  // starves every later request to that origin — including full-document
  // navigations, which then hang with no error. This is the same defect
  // spec-118 fixed in useDocChangeStream.

  it('shares ONE connection across multiple subscribers', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    renderHook(() => useUserChangeStream(a));
    renderHook(() => useUserChangeStream(b));
    renderHook(() => useUserChangeStream(c));

    await waitFor(() => expect(streams.length).toBe(1));
    // Give any stray second connection a chance to appear before asserting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(streams.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    streams[0].push('event: user_change\ndata: {"entity":"mcp_token"}\n\n');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('fans one event out by entity — each subscriber applies its OWN filter', async () => {
    const tokens = vi.fn();
    const slack = vi.fn();
    const all = vi.fn();
    renderHook(() => useUserChangeStream(tokens, ['mcp_token']));
    renderHook(() => useUserChangeStream(slack, ['user_slack_token']));
    renderHook(() => useUserChangeStream(all));

    await waitFor(() => expect(streams.length).toBe(1));
    streams[0].push('event: user_change\ndata: {"entity":"user_slack_token"}\n\n');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(tokens).not.toHaveBeenCalled();
  });

  it('opens SEPARATE connections for different tokens (stream scope includes identity)', async () => {
    renderHook(() => useUserChangeStreamWithToken('token-a', vi.fn()));
    renderHook(() => useUserChangeStreamWithToken('token-b', vi.fn()));
    await waitFor(() => expect(streams.length).toBe(2));
  });

  it('keeps the shared connection open until the LAST subscriber unmounts', async () => {
    const first = renderHook(() => useUserChangeStream(vi.fn()));
    const second = renderHook(() => useUserChangeStream(vi.fn()));
    await waitFor(() => expect(streams.length).toBe(1));

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;

    first.unmount();
    expect(signal.aborted).toBe(false);

    second.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('aborts the in-flight fetch and clears debounce on unmount (no orphan callbacks)', async () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useUserChangeStream(onEvent));

    await waitFor(() => expect(streams.length).toBe(1));

    streams[0].push('event: user_change\ndata: {"entity":"mcp_token"}\n\n');
    unmount();

    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onEvent).not.toHaveBeenCalled();

    const callsBefore = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
