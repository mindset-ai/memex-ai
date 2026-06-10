// spec-222 — the injected backend descriptor. The guide-LLM proxy leg
// (guideLlmClient.ts) used to reach into the app's `../api/http` (tenantBase /
// BASE_URL) and `../api/client` (fetchWithRetry). The engine can't import the app,
// so the host now injects the base URL + (optionally) a retrying fetch through
// this module. The app re-injects `{ baseUrl: tenantBase() ?? BASE_URL, fetchImpl:
// fetchWithRetry }` at mount; a plain host gets the default `/api` + global fetch.

export interface GuideBackend {
  /** Base URL the guide endpoints hang off (e.g. the tenant-scoped `/api/ns/mx`). */
  baseUrl: string;
  /** Optional fetch implementation (the app injects a retrying one). Defaults to
   *  the global `fetch`. */
  fetchImpl?: typeof fetch;
}

let backend: GuideBackend = { baseUrl: '/api' };

/** Inject the host's backend descriptor (base URL + optional retrying fetch). */
export function setGuideBackend(b: GuideBackend): void {
  backend = b;
}

/** The currently-injected backend descriptor (defaults to `/api` + global fetch). */
export function getGuideBackend(): GuideBackend {
  return backend;
}
