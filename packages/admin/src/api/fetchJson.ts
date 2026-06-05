// Single-call wrapper that consolidates the 60+ hand-rolled response checks in client.ts.
//
// Replaces patterns like:
//   const res = await fetchWithRetry(url, init);
//   if (!res.ok) throw new Error(`Failed: ${res.status}`);
//   return res.json();
//
// With:
//   return fetchJson<DocSummary[]>(url, init);
//
// Throws ApiError (or a subclass) on non-2xx responses; subclass selection is handled by
// the optional `errorFactory` for endpoints that need typed errors (auth/account/share).

import { ApiError, NotFoundError } from './errors';

export interface FetchJsonOptions {
  /** Optional bearer token. Set if you want to override the auto-attach behaviour in fetchWithRetry. */
  token?: string | null;
  /** Treat response body as text instead of JSON (rare — agent SSE etc.). */
  asText?: boolean;
  /** Map !res.ok responses to a custom error class. Default: throw NotFoundError on 404, ApiError otherwise. */
  errorFactory?: (status: number, body: unknown) => Error;
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wraps a Fetcher with response.ok handling + JSON parsing. Throws on non-2xx.
 *
 * Pass `fetcher` (typically `fetchWithRetry`) explicitly so this module has no dependency
 * on client.ts (avoiding the cycle that would otherwise form once client.ts re-exports
 * fetchJson for consumers).
 */
export async function fetchJson<T>(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: FetchJsonOptions,
): Promise<T> {
  const finalInit = opts?.token
    ? { ...init, headers: { ...init?.headers, Authorization: `Bearer ${opts.token}` } }
    : init;

  const res = await fetcher(input, finalInit);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (opts?.errorFactory) throw opts.errorFactory(res.status, body);
    if (res.status === 404) {
      throw new NotFoundError(body?.message ?? body?.error ?? `Not found (${res.status})`);
    }
    throw new ApiError(
      res.status,
      body?.message ?? body?.error ?? `Request failed: ${res.status}`,
      body?.code,
    );
  }

  if (opts?.asText) return (await res.text()) as unknown as T;
  return res.json() as Promise<T>;
}
