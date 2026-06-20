// spec-315 — the graduated Home surface. Caller-scoped (user-level): GET /api/me/home
// returns the two derived blocks aggregated across all the user's Memexes.
import { BASE_URL, fetchOnce } from './http';

// A spec the user has recently worked on, in one of their Memexes. `path` is the
// fully-qualified cross-Memex route (`/<ns>/<memex>/specs/<handle>`) — navigate to it
// directly; do NOT re-prefix with the current tenant.
export interface SpecInFlight {
  docId: string;
  handle: string;
  title: string;
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
  path: string;
  lastActivityAt: string;
}

// A comment that pulls the user in (spec-320's read contract; populated once 320 lands).
export interface WhereNeededItem {
  commentId: string;
  kind: 'mention' | 'assignment';
  snippet: string;
  specTitle: string;
  path: string;
  memexName: string;
  memexSlug: string;
  namespaceSlug: string;
  at: string;
}

export interface HomeResponse {
  whereYoureNeeded: WhereNeededItem[];
  specsInFlight: SpecInFlight[];
}

export async function fetchHomeApi(): Promise<HomeResponse> {
  const res = await fetchOnce(`${BASE_URL}/me/home`);
  if (!res.ok) throw new Error(`home ${res.status}`);
  return (await res.json()) as HomeResponse;
}
