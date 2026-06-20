// spec-315 — the graduated Home surface. Caller-scoped (user-level): GET /api/me/home
// returns the two derived blocks aggregated across all the user's Memexes. Polled every
// ~3s by HomeValue for ≤4s live freshness (dec-2).
import { BASE_URL, fetchOnce } from './http';
import type { AcHealth } from './types';

// A spec the user owns or has worked on — carries the data the Pulse HotSpecCard needs.
// `path` is the fully-qualified cross-Memex route; navigate to it directly.
export interface HomeWorker {
  actorUserId: string | null;
  actorName: string | null;
  actorKind: string;
  lastSeenMs: number;
}

export interface HomeSpecCard {
  docId: string;
  handle: string;
  title: string;
  phase: string;
  narrative: string | null;
  health: AcHealth | null;
  spark: number[];
  involved: HomeWorker[];
  lastActivityMineMs: number | null;
  lastActivityAnyMs: number | null;
  tier: 'assigned' | 'mine';
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
  path: string;
}

// A comment that pulls the user in (spec-320's read contract). `path` deep-links to the
// highlighted comment via `?comment=c-N` (dec-4).
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
  specs: HomeSpecCard[];
}

export async function fetchHomeApi(): Promise<HomeResponse> {
  const res = await fetchOnce(`${BASE_URL}/me/home`);
  if (!res.ok) throw new Error(`home ${res.status}`);
  return (await res.json()) as HomeResponse;
}
