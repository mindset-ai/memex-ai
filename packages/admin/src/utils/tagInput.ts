// spec-136 t-6 — UI-side tag-string parsing. Mirrors the server's
// parseTagInput (packages/server/src/services/tags.ts) so the picker can:
//   - split `scope::value` exactly the way the backend will (first `::` only),
//   - reflect per-scope mutual exclusivity in the UI before the round-trip,
//   - and decide whether the typed text is a valid new tag (enable "Create").
//
// Unlike the server helper this NEVER throws — invalid/empty input returns
// `null` so the picker can simply disable the create affordance. The server
// remains the source of truth: the picker sends the raw `scope::value`/flat
// string and trusts the resolved Tag rows it gets back.

import type { Tag } from '../api/types';

const SCOPE_SEPARATOR = '::';

export interface ParsedTagInput {
  /** Part before the first `::` (trimmed). `null` for a flat tag. */
  scope: string | null;
  /** Part after the first `::`, or the whole flat tag. Never empty. */
  value: string;
}

/**
 * Parse a `scope::value` (or flat) string into `{ scope, value }`.
 * Returns `null` when the input is empty or has an empty value (e.g. `priority::`)
 * — the picker treats that as "not yet a valid tag".
 *
 * Only the FIRST `::` separates scope from value, matching the server:
 *   `priority::high`   → { scope: 'priority', value: 'high' }
 *   `bug`              → { scope: null, value: 'bug' }
 *   `a::b::c`          → { scope: 'a', value: 'b::c' }
 *   `::high` / `  `    → null-scope or null result per the rules above
 */
export function parseTagInput(raw: string): ParsedTagInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const idx = trimmed.indexOf(SCOPE_SEPARATOR);
  if (idx === -1) return { scope: null, value: trimmed };

  const scope = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + SCOPE_SEPARATOR.length).trim();
  if (!value) return null;
  return { scope: scope || null, value };
}

/** Render a structured tag back to its `scope::value` (or flat) string form. */
export function formatTagInput(tag: Pick<Tag, 'scope' | 'value'>): string {
  return tag.scope === null || tag.scope === undefined
    ? tag.value
    : `${tag.scope}${SCOPE_SEPARATOR}${tag.value}`;
}

/**
 * Stable identity key for a tag's `{scope, value}` pair, used to dedupe and to
 * compare a tag against the typed text without an id. `scope === null` (flat)
 * and `scope === ''` collapse to the same key as the server (empty scope → flat).
 */
export function tagKey(tag: Pick<Tag, 'scope' | 'value'>): string {
  const scope = tag.scope ? tag.scope : '';
  return `${scope}${SCOPE_SEPARATOR}${tag.value}`;
}

/** Case-insensitive substring match of `query` against a tag's `scope::value`. */
export function tagMatchesQuery(tag: Pick<Tag, 'scope' | 'value'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return formatTagInput(tag).toLowerCase().includes(q);
}
