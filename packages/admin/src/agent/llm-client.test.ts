import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/client', () => ({
  fetchWithRetry: vi.fn(),
}));

import { callLlmProxy, callLlmCreateProxy, setLlmAuthToken } from './llm-client';
import { fetchWithRetry } from '../api/client';

function sseChunk(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function fakeResponse(body: ReadableStream, status = 200): Response {
  return new Response(body, { status });
}

async function collectEvents(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('LLM SSE client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLlmAuthToken(null);
  });

  afterEach(() => {
    setLlmAuthToken(null);
  });

  it('yields text_delta events with correct text', async () => {
    const stream = sseChunk([
      { event: 'text_delta', data: { text: 'Hello' } },
      { event: 'text_delta', data: { text: ' world' } },
    ]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    const events = await collectEvents(callLlmProxy({ messages: [] }));

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ]);
  });

  it('yields message_complete events with content and stopReason', async () => {
    const content = [{ type: 'text', text: 'Done' }];
    const stream = sseChunk([
      { event: 'message_complete', data: { content, stopReason: 'end_turn' } },
    ]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    const events = await collectEvents(callLlmProxy({ messages: [] }));

    expect(events).toEqual([
      { type: 'message_complete', content, stopReason: 'end_turn' },
    ]);
  });

  it('handles error events from the stream', async () => {
    const stream = sseChunk([
      { event: 'error', data: { message: 'Rate limit exceeded' } },
    ]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    const events = await collectEvents(callLlmProxy({ messages: [] }));

    expect(events).toEqual([
      { type: 'error', message: 'Rate limit exceeded' },
    ]);
  });

  it('skips malformed SSE data lines without throwing', async () => {
    // Simulate a stream with one valid event and one with unparseable JSON
    const encoder = new TextEncoder();
    const raw =
      `event: text_delta\ndata: {not valid json}\n\n` +
      `event: text_delta\ndata: ${JSON.stringify({ text: 'ok' })}\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    const events = await collectEvents(callLlmProxy({ messages: [] }));

    // Only the valid event should come through
    expect(events).toEqual([{ type: 'text_delta', text: 'ok' }]);
  });

  it('handles SSE data split across multiple chunks', async () => {
    const encoder = new TextEncoder();
    const fullEvent = `event: text_delta\ndata: ${JSON.stringify({ text: 'split' })}\n\n`;
    // Split in the middle of the event
    const part1 = fullEvent.slice(0, 15);
    const part2 = fullEvent.slice(15);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    const events = await collectEvents(callLlmProxy({ messages: [] }));

    expect(events).toEqual([{ type: 'text_delta', text: 'split' }]);
  });

  it('throws on 403 with message from response body', async () => {
    const body = JSON.stringify({ message: 'Unauthorized domain' });
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(
      new Response(body, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of callLlmProxy({ messages: [] })) {
        // consume
      }
    }).rejects.toThrow('Unauthorized domain');
  });

  it('callLlmCreateProxy hits the /llm/chat/create endpoint', async () => {
    const stream = sseChunk([
      { event: 'text_delta', data: { text: 'hi' } },
    ]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    await collectEvents(callLlmCreateProxy({ messages: [] }));

    const calledUrl = vi.mocked(fetchWithRetry).mock.calls[0][0] as string;
    expect(calledUrl).toContain('/llm/chat/create');
  });

  it('includes Authorization header when token is set', async () => {
    const stream = sseChunk([
      { event: 'text_delta', data: { text: 'ok' } },
    ]);
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(fakeResponse(stream));

    setLlmAuthToken('test-token-123');
    await collectEvents(callLlmProxy({ messages: [] }));

    const calledInit = vi.mocked(fetchWithRetry).mock.calls[0][1] as RequestInit;
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-token-123'
    );
  });
});
