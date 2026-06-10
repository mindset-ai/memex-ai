// spec-190 t-3 / dec-1 / dec-2: the guide's LLM call over the server SSE proxy.
// The guide graph (guideGraph.ts) is client-side; its brain runs through this
// proxy exactly like the main agent's llm-client.ts — server-side prompt + tool
// assembly, key never in the browser, no server-side graph runtime and no
// externally-reachable custom-LLM endpoint (ac-11). The voice AUDIO leg is the
// separate WebSocket (routes/voice.ts, dec-9); this is the TEXT leg.
//
// Distinct from agent/llm-client.ts: the guide endpoint carries NO doc/tenant
// context — only the current screen (screenKey + the screen's highlightable
// elements + pre-fetched guide-content chunks). The guide teaches the product;
// it never reads tenant data (dec-4).

// spec-222 (ac-9): the engine no longer reaches into the app's `../api/*`. The
// host injects the base URL + (optionally) a retrying fetch through the backend
// descriptor (backend.ts); the app re-injects `fetchWithRetry` so the retry
// behaviour is preserved app-side.
import { getGuideBackend } from './backend';
import type { MessageParam, LlmProxyEvent } from './agent-types';

/** A highlightable element on the current screen (subset of the dec-3 registry;
 *  t-4 provides the canonical type in @memex/shared). */
export interface GuideScreenElement {
  id: string;
  description: string;
}

export interface GuideLlmInput {
  messages: MessageParam[];
  /** Current screen's stable key (route-derived), or null before resolution. */
  screenKey: string | null;
  /** The current screen's highlightable elements (dec-3). */
  screenRegistry: GuideScreenElement[];
  /** Pre-fetched guide-content chunks for the current screen (dec-6, t-6). */
  guideContext: string[];
}

let authToken: string | null = null;
export function setGuideAuthToken(token: string | null): void {
  authToken = token;
}

/** Parse the server's SSE stream into typed guide-LLM events (shared shape with
 *  the main agent proxy). */
async function* parseGuideSSE(res: Response): AsyncGenerator<LlmProxyEvent> {
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
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (eventType === 'text_delta') {
        yield { type: 'text_delta', text: parsed.text };
      } else if (eventType === 'message_complete') {
        yield { type: 'message_complete', content: parsed.content, stopReason: parsed.stopReason };
      } else if (eventType === 'error') {
        yield { type: 'error', message: parsed.message };
      }
    }
  }
}

/**
 * Stream a guide turn from the server SSE proxy. The server injects the guide
 * system prompt + the screen context + the guide toolset and proxies Anthropic;
 * we never assemble prompts or hold keys client-side.
 */
export async function* callGuideLlmProxy(
  input: GuideLlmInput,
  signal?: AbortSignal,
): AsyncGenerator<LlmProxyEvent> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  // spec-222 (ac-9): base URL + fetch come from the injected backend descriptor.
  // The app re-injects a retrying fetchImpl, so the prior retry behaviour is kept
  // host-side; a plain host gets a single global `fetch`.
  const { baseUrl, fetchImpl } = getGuideBackend();
  const res = await (fetchImpl ?? fetch)(`${baseUrl}/voice/guide-chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    let message = `Guide LLM proxy failed: ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    yield { type: 'error', message };
    return;
  }

  yield* parseGuideSSE(res);
}
