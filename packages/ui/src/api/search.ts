// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

// ── Search (spec-64 — omnibox over GET /api/<ns>/<mx>/search) ─────────────────
// Thin typed client over the read-only search route (spec-64 t-1/t-2). The
// server projects every lane onto the same UUID-stripped public hit shape and
// returns the `{ jumpTo, assigned, content }` envelope; the omnibox (spec-64
// t-3/t-4) renders the three lanes as tiers. Public-read: the auto-attached
// session token (when present) lets a member search a private memex, while an
// anonymous request to a public memex still works (the route gates reads
// server-side, not here).

/** The user-facing entity kinds searchMemex accepts (server MemexSearchKind). */
export type SearchHitKind = 'spec' | 'standard' | 'document' | 'decision' | 'issue';

/** Which search channel surfaced a hit/section (handle | fts | semantic). */
export type SearchStrategy = string;

/** A section of a content hit that matched the query (spec-64 t-1). */
export interface SearchMatchingSection {
  id: string;
  sectionType: string;
  title: string | null;
  content: string;
  matchedVia: SearchStrategy;
}

/**
 * The public, UUID-stripped hit shape shared by all three lanes (spec-64 t-1
 * ac-7). `path` is the canonical path WITHOUT a leading slash, e.g.
 * `mindset-prod/memex-building-itself/specs/spec-34` — navigate by prefixing
 * `/`. `jumpTo`/`assigned` hits carry `matchingSections: []` (navigation rows);
 * `content` hits carry the populated body match.
 */
export interface SearchHit {
  kind: SearchHitKind;
  path: string;
  title: string;
  status: string;
  score: number;
  strategies: SearchStrategy[];
  matchingSections: SearchMatchingSection[];
  decisionSnippet?: string;
  decisionMatchedVia?: SearchStrategy;
  /** WHO — best-effort display name of who authored / last touched this hit
   *  (spec-285). null/absent on navigation-only lanes (jumpTo/assigned). */
  authorName?: string | null;
  /** WHEN — ISO-8601 timestamp of when this hit was last changed (spec-285). */
  lastUpdatedAt?: string | null;
}

/** The `{ jumpTo, assigned, content }` envelope (spec-64 t-1 ac-6). */
export interface SearchEnvelope {
  jumpTo: SearchHit[];
  assigned: SearchHit[];
  content: SearchHit[];
}

export interface SearchOptions {
  /** Scope to a single entity kind; unset searches every kind. */
  kind?: SearchHitKind;
  /** Cap the content lane (server default 8). Must be a positive integer. */
  limit?: number;
  /** Abort signal so a superseded debounced query can cancel its in-flight request. */
  signal?: AbortSignal;
}

/**
 * Search the current memex. GET /api/<ns>/<mx>/search?q=&kind=&limit= — returns
 * the `{ jumpTo, assigned, content }` envelope (spec-64 t-1/t-2). The omnibox
 * debounces `q` (~150ms) before calling this. An empty/whitespace query short-
 * circuits to an empty envelope without a round-trip (the server would 200 with
 * empty lanes anyway, but skipping the call keeps the palette quiet on open).
 */
export async function searchMemexApi(
  query: string,
  opts?: SearchOptions,
): Promise<SearchEnvelope> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { jumpTo: [], assigned: [], content: [] };
  }
  const params = new URLSearchParams({ q: trimmed });
  if (opts?.kind) params.set('kind', opts.kind);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  return fetchJsonRaw<SearchEnvelope>(
    fetchWithRetry,
    `${tBase()}/search?${params.toString()}`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
}
