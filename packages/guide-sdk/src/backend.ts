// spec-222 — the injected backend descriptor. The guide-LLM proxy leg
// (guideLlmClient.ts) used to reach into the app's `../api/http` (tenantBase /
// BASE_URL) and `../api/client` (fetchWithRetry). The engine can't import the app,
// so the host now injects the base URL + (optionally) a retrying fetch through
// this module. The app re-injects `{ baseUrl: tenantBase() ?? BASE_URL, fetchImpl:
// fetchWithRetry }` at mount; a plain host gets the default `/api` + global fetch.

export interface GuideBackend {
  /** Base URL the guide endpoints hang off (e.g. the tenant-scoped `/api/ns/mx`,
   *  or the website's versioned `/guide/v1`). */
  baseUrl: string;
  /** Optional fetch implementation (the app injects a retrying one). Defaults to
   *  the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** SSE chat leg path appended to `baseUrl`. The Memex app's authenticated route
   *  is `/voice/guide-chat` (default); the public website's is `/chat`. */
  chatPath?: string;
  /** WS voice leg path appended to `baseUrl`. The app's is `/voice/session`
   *  (default); the public website's is `/voice`. */
  voicePath?: string;
  /** When true, the anon session token rides the connect QUERY (`?token=`) on the
   *  SSE leg too (the public `/guide/v1` endpoint reads `?token=` on both legs).
   *  The app leaves this false and authenticates the SSE leg with an
   *  `Authorization: Bearer` header (validated by sessionMiddleware). */
  tokenInQuery?: boolean;
}

/** Defaults match the Memex app's authenticated routing exactly, so a host that
 *  sets only `baseUrl` (the app) is unchanged. */
export const DEFAULT_CHAT_PATH = '/voice/guide-chat';
export const DEFAULT_VOICE_PATH = '/voice/session';

let backend: GuideBackend = { baseUrl: '/api' };

/** Inject the host's backend descriptor (base URL + optional retrying fetch). */
export function setGuideBackend(b: GuideBackend): void {
  backend = b;
}

/** The currently-injected backend descriptor (defaults to `/api` + global fetch). */
export function getGuideBackend(): GuideBackend {
  return backend;
}
