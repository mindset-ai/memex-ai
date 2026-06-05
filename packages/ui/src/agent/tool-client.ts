import { fetchWithRetry } from '../api/client';
import { tenantBase, BASE_URL } from '../api/http';

// t-18 of doc-15 (F.3): /api/llm/* is tenancy-scoped. Use tenantBase() so the
// browser's current Memex context maps to /api/<ns>/<mx>/llm/tools/execute;
// fall back to the flat surface for std-5 single-membership inference.
function llmBase(): string {
  return tenantBase() ?? BASE_URL;
}

let authToken: string | null = null;

export function setToolAuthToken(token: string | null) {
  authToken = token;
}

/**
 * Executes a server-side tool via the tool executor endpoint.
 * Returns the result string or throws on error.
 *
 * `docId` is the UUID of the doc the chat is bound to (omitted during the
 * creation phase). The server threads it into the tool ctx so search_memex
 * can default-exclude self-hits (b-34 T-12).
 */
export async function executeToolRemote(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  docId?: string,
  mode?: 'drift'
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // spec-143 t-4 (dec-6): in drift mode there is no bound doc — send `mode` so
  // the server runs the drift tool surface with docId null (drift tools are
  // memex-scoped via their input, not doc-scoped). Otherwise the spec path is
  // byte-for-byte unchanged: `mode` and `docId` are each included only when set.
  const reqBody: Record<string, unknown> = { toolName, input };
  if (docId) reqBody.docId = docId;
  if (mode) reqBody.mode = mode;

  const res = await fetchWithRetry(`${llmBase()}/llm/tools/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
    signal,
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(body.error ?? `Tool execution failed: ${res.status}`);
  }

  return body.result;
}
