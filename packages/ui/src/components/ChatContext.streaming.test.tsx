import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// The point of this test file is to exercise the real client-side streaming
// path — ChatContext → useAgentGraph → graph → parseLlmSSE consumer loop — and
// observe whether React commits `messages[].content` between text deltas, or
// whether it batches many deltas into a single render (which is what the user
// perceives as "thinking... then a blob appears").
//
// We mock ONLY at the network boundary: callLlmProxy / callLlmCreateProxy are
// replaced with async generators that yield text_delta events with REAL
// setTimeout gaps. Everything above that (the for-await loop in graph.ts,
// onTextDelta → setMessages in ChatContext, React rendering) runs for real.
// If React is batching, the intermediate-state assertions below will fail.

vi.mock('../agent/llm-client', () => ({
  callLlmProxy: vi.fn(),
  callLlmCreateProxy: vi.fn(),
  setLlmAuthToken: vi.fn(),
}));

vi.mock('../agent/tool-client', () => ({
  setToolAuthToken: vi.fn(),
  executeToolRemote: vi.fn(),
}));

vi.mock('../agent/conversation-client', () => ({
  setConversationAuthToken: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversation: vi.fn().mockResolvedValue([]),
  clearConversationRemote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

import { ChatProvider, useChat } from './ChatContext';
import { callLlmProxy, callLlmCreateProxy } from '../agent/llm-client';

function wrapper({ children }: { children: ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

/**
 * Build an async generator that yields text_delta events with `gapMs`
 * setTimeout gaps between each, followed by a message_complete. The gaps are
 * REAL macrotask boundaries — the same kind the network gives you between SSE
 * chunks — so React has every opportunity to flush setMessages between them.
 * If the test fails, it's because the UI isn't committing intermediate state
 * despite React getting fair chances to paint.
 */
async function* timedDeltaStream(tokens: string[], gapMs: number) {
  for (const token of tokens) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield { type: 'text_delta' as const, text: token };
  }
  yield {
    type: 'message_complete' as const,
    content: [{ type: 'text' as const, text: tokens.join('') }],
    stopReason: 'end_turn',
  };
}

describe('ChatContext — progressive streaming render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('commits assistant content incrementally as text_delta events arrive (document-phase)', async () => {
    // 5 tokens, 60ms apart: more than enough time for React to paint between
    // each if it is not batching. Total stream duration ~300ms.
    vi.mocked(callLlmProxy).mockImplementation(() =>
      timedDeltaStream(['Hel', 'lo', ' wo', 'rld', '!'], 60)
    );

    const { result } = renderHook(() => useChat(), { wrapper });

    act(() => {
      result.current.setDocId('doc-1');
    });

    // Fire-and-forget the send. We specifically do NOT `await act(async () => sendMessage(...))`
    // because act() drains all pending work before returning — that would
    // collapse every intermediate React commit into the final state and
    // completely mask the "thinking... then blob" behaviour we're trying to
    // catch.
    act(() => {
      void result.current.sendMessage('hi');
    });

    const assistantContent = () => {
      const msg = result.current.messages.find((m) => m.role === 'assistant');
      return msg?.content ?? '';
    };

    // After the first delta fires we should see "Hel" on screen — NOT the
    // full joined response. If React is batching deltas until the stream
    // completes, we'll time out here waiting for the intermediate state to
    // appear.
    await waitFor(
      () => {
        expect(assistantContent()).toBe('Hel');
      },
      { timeout: 500, interval: 10 }
    );

    // And before the full stream completes we should be able to observe a
    // partial, mid-stream content (anything shorter than the full response).
    await waitFor(
      () => {
        const content = assistantContent();
        expect(content.length).toBeGreaterThan(0);
        expect(content.length).toBeLessThan('Hello world!'.length);
      },
      { timeout: 500, interval: 10 }
    );

    // Finally the full stream should land.
    await waitFor(() => {
      expect(assistantContent()).toBe('Hello world!');
      expect(result.current.isStreaming).toBe(false);
    }, { timeout: 2000 });
  });

  it('commits assistant content incrementally during creation-phase streaming', async () => {
    // Same test, creation phase (docId = null) — this is the path the user
    // hits from the NewSpecModal on the document list page. We exercise
    // it separately because it uses callLlmCreateProxy, not callLlmProxy.
    vi.mocked(callLlmCreateProxy).mockImplementation(() =>
      timedDeltaStream(['Star', 'ting ', 'draft', '...'], 60)
    );

    const { result } = renderHook(() => useChat(), { wrapper });

    // Give the chat a non-empty context so sendMessage is willing to fire
    // without a docId (NewSpecModal uses context chips; any chip works).
    act(() => {
      result.current.addContextChip({
        type: 'section',
        id: 'chip-1',
        label: 'any',
      });
    });

    act(() => {
      void result.current.sendMessage('new spec');
    });

    const assistantContent = () => {
      const msg = result.current.messages.find((m) => m.role === 'assistant');
      return msg?.content ?? '';
    };

    await waitFor(
      () => {
        expect(assistantContent()).toBe('Star');
      },
      { timeout: 500, interval: 10 }
    );

    await waitFor(() => {
      expect(assistantContent()).toBe('Starting draft...');
      expect(result.current.isStreaming).toBe(false);
    }, { timeout: 2000 });
  });
});
