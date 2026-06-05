import { fetchWithRetry } from '../api/client';
import { tenantBase, BASE_URL } from '../api/http';
import type { MessageParam, LlmProxyEvent } from './types';

// t-18 of doc-15 (F.3): /api/llm/* is tenancy-scoped now. The path-prefixed
// mount is at /api/<namespace>/<memex>/llm/* (with the same flat fallback
// the rest of the tenancy-scoped routers carry for the std-5 single-
// membership case). Use tenantBase() to build the URL from the current
// browsing context.
function llmBase(): string {
  return tenantBase() ?? BASE_URL;
}

let authToken: string | null = null;

export function setLlmAuthToken(token: string | null) {
  authToken = token;
}

/**
 * Shared SSE stream parser for LLM proxy responses.
 */
async function* parseLlmSSE(res: Response): AsyncGenerator<LlmProxyEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      if (!part.trim()) continue;

      let eventType = '';
      let data = '';

      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim();
        }
      }

      if (!data) continue;

      try {
        const parsed = JSON.parse(data);

        if (eventType === 'text_delta') {
          yield { type: 'text_delta', text: parsed.text };
        } else if (eventType === 'message_complete') {
          yield {
            type: 'message_complete',
            content: parsed.content,
            stopReason: parsed.stopReason,
          };
        } else if (eventType === 'error') {
          yield { type: 'error', message: parsed.message };
        }
      } catch {
        // Skip malformed events
      }
    }
  }
}

async function postLlm(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    if (res.status === 403) {
      const respBody = await res.json().catch(() => null);
      throw new Error(
        respBody?.message ?? 'Sorry, access is limited to authorized email domains.'
      );
    }
    if (res.status === 503) {
      // Server signals that LLM features are disabled (e.g., missing ANTHROPIC_API_KEY).
      // Surface the server's message verbatim so callers can render it as a friendly banner
      // instead of the raw Anthropic SDK auth error.
      const respBody = await res.json().catch(() => null);
      throw new Error(
        respBody?.message ?? 'The AI assistant is temporarily unavailable on this server.'
      );
    }
    throw new Error(`LLM proxy request failed: ${res.status}`);
  }

  return res;
}

/**
 * Calls the main LLM proxy endpoint (document-aware agent phase).
 */
export async function* callLlmProxy(
  params: {
    docId?: string;
    messages: MessageParam[];
    /** spec-143 t-4 (dec-6): when 'drift', the server runs the drift agent —
     *  open-drift context, drift prompt, drift tool subset, docId null. */
    mode?: 'drift';
  },
  signal?: AbortSignal
): AsyncGenerator<LlmProxyEvent> {
  const res = await postLlm(`${llmBase()}/llm/chat`, params, signal);
  yield* parseLlmSSE(res);
}

/**
 * Calls the creation LLM proxy endpoint (document creation phase).
 * Uses a focused system prompt and only create_doc + UI tools.
 */
export async function* callLlmCreateProxy(
  params: { messages: MessageParam[] },
  signal?: AbortSignal
): AsyncGenerator<LlmProxyEvent> {
  const res = await postLlm(`${llmBase()}/llm/chat/create`, params, signal);
  yield* parseLlmSSE(res);
}
