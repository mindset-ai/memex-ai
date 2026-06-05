import { fetchWithRetry } from '../api/client';
import { tenantBase, BASE_URL } from '../api/http';
import type { MessageParam } from './types';

// t-18 of doc-15 (F.3): /api/llm/* is tenancy-scoped now. Use tenantBase() so the
// caller's current Memex (from the browser host) maps to /api/<ns>/<mx>/llm/...;
// fall back to the flat surface for the std-5 single-membership case.
function llmBase(): string {
  return tenantBase() ?? BASE_URL;
}

let authToken: string | null = null;

export function setConversationAuthToken(token: string | null) {
  authToken = token;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) h['Authorization'] = `Bearer ${authToken}`;
  return h;
}

/** Save the full conversation to the server (replaces existing). */
export async function saveConversation(
  docId: string,
  messages: MessageParam[]
): Promise<void> {
  await fetchWithRetry(`${llmBase()}/llm/conversations`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ docId, messages }),
  });
}

/** Load stored conversation messages for a document. */
export async function loadConversation(
  docId: string
): Promise<MessageParam[]> {
  const res = await fetchWithRetry(`${llmBase()}/llm/conversations/${docId}`, {
    headers: headers(),
  });
  if (!res.ok) return [];
  const body = await res.json();
  return body.messages ?? [];
}

/** Clear the conversation for a document. */
export async function clearConversationRemote(docId: string): Promise<void> {
  await fetchWithRetry(`${llmBase()}/llm/conversations/${docId}/clear`, {
    method: 'POST',
    headers: headers(),
  });
}
