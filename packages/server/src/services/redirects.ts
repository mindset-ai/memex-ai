// b-36 T-4 — redirect layer for cross-memex Spec moves + ns/memex renames.
//
// Per b-36 D-6, canonical refs (e.g. `mindset/personal/specs/spec-12`) survive
// move events via a single `redirects` table:
//
//   * ONE row per move event. The resolver prefix-matches on read so child
//     paths inherit (e.g. moving spec-12 carries `.../spec-12/tasks/t-1` along
//     for free) without per-entity rows.
//   * `reason` ∈ {brief_move, memex_rename, namespace_rename, brief_to_spec_rename}
//     — DB CHECK enforces. `brief_move` is kept on the enum so existing rows
//     remain valid post-Spec rename; new move events should still record under
//     it (it predates the Brief → Spec vocabulary flip).
//   * Direct entity lookup runs first (T-5); this layer is the fallback.
//   * Transitive chains (A→B + B→C) are followed in-app with a visited-set
//     cycle guard, capped at `maxDepth` (default 10).
//   * No automatic expiry — redirects are permanent rows. Re-recording a
//     move is idempotent (UPSERT on the primary key).
//
// b-105 layered onto this a *code-level* path-shape rewrite for the
// /briefs/b-N → /specs/spec-N URL rename (see `rewriteBriefPathToSpec`
// below). That rewrite is a pure regex, not a DB row, and runs *before*
// the DB lookup — every old Brief URL becomes a permanent 301 to its Spec
// equivalent without inserting one redirect row per Brief.

import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { parseRef } from "./refs.js";
import { validateSlugFormat } from "./shared/slug.js";

// db and a transaction handle both satisfy this. It lets a caller record a
// redirect inside its own transaction (e.g. renameMemexSlug) so the rename and
// its redirect row commit atomically — a half-applied rename would recreate the
// std-10 §7 "old links 404" bug this layer exists to prevent.
type SqlExecutor = { execute: (query: SQL) => Promise<unknown> };

export type RedirectReason =
  | "brief_move"
  | "memex_rename"
  | "namespace_rename"
  | "brief_to_spec_rename";

export type LookupResult =
  | { redirected: string }
  | { notFound: true };

const DEFAULT_MAX_DEPTH = 10;

// One step of the lookup state machine: try an exact match first, then the
// longest-prefix match. Returns the rewrite if either hit; null if neither.
// Single SQL round-trip per step — the resolver hot path is one query per
// chain hop, so chains of depth N cost N round-trips.
async function lookupOneStep(path: string): Promise<string | null> {
  // The query covers both cases at once:
  //   * exact match  :    `path = old_path`
  //   * prefix match :    `path LIKE old_path || '/%'`
  // ORDER BY length(old_path) DESC + LIMIT 1 picks the longest match, so if
  // both an exact row and a shorter-prefix row exist the exact row wins
  // (its old_path equals the input — longest possible match).
  const rows = (await db.execute(sql`
    SELECT old_path, new_path
      FROM redirects
     WHERE ${path} = old_path
        OR ${path} LIKE old_path || '/%'
     ORDER BY length(old_path) DESC
     LIMIT 1
  `)) as unknown as Array<{ old_path: string; new_path: string }>;

  if (rows.length === 0) {
    return null;
  }

  const { old_path, new_path } = rows[0];

  // Exact match — full rewrite.
  if (path === old_path) {
    return new_path;
  }

  // Prefix match — preserve the suffix after old_path. We know
  // path.startsWith(old_path + '/') from the LIKE filter.
  const suffix = path.slice(old_path.length);
  return new_path + suffix;
}

// Resolve `path` through the redirect chain. Returns the final rewritten
// path, or {notFound} if no row matched at the first step. Walks at most
// `maxDepth` hops and throws on cycles or runaway chains — a clean signal
// to the caller that the redirect table is corrupt rather than silently
// returning a partial rewrite.
export async function lookupRedirect(
  path: string,
  opts?: { maxDepth?: number }
): Promise<LookupResult> {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const visited = new Set<string>([path]);
  let current = path;
  let rewrites = 0;

  while (rewrites < maxDepth) {
    const next = await lookupOneStep(current);
    if (next === null) {
      // No further redirect. If we've rewritten at least once, return the
      // last successful rewrite; otherwise the path was never matched.
      return rewrites === 0 ? { notFound: true } : { redirected: current };
    }

    // Cycle guard: the chain has returned to a path we've already seen.
    if (visited.has(next)) {
      throw new Error(
        `Redirect cycle detected at "${next}" (chain: ${[...visited, next].join(" → ")})`
      );
    }

    visited.add(next);
    current = next;
    rewrites += 1;
  }

  // Hit the depth limit without terminating — chain is either pathological
  // or genuinely deeper than the cap. Either way it's a corruption signal.
  throw new Error(
    `Redirect chain exceeded maxDepth=${maxDepth} starting from "${path}" (last: "${current}")`
  );
}

// ── b-105 — permanent path-shape rewrite: /briefs/b-N → /specs/spec-N ─────
//
// The Brief → Spec rename flipped both the doc-type URL segment and the
// handle prefix. Every old canonical path of the form
//     <ns>/<mx>/briefs/b-<N>(/<child-type>/<child-handle>)?
// must permanently 301 to
//     <ns>/<mx>/specs/spec-<N>(/<child-type>/<child-handle>)?
//
// The handle delta (`b-N` → `spec-N`) is the only piece the children share —
// `dec-M`, `t-M`, `c-M`, `s-M` carry through unchanged. So a single regex
// over the four path shapes (doc-only, decisions, tasks, comments) plus the
// /briefs collection root covers every case.
//
// This rewrite is permanent (status 301) and pure: it neither reads from
// nor writes to the redirects table. The resolver should call it BEFORE the
// DB lookup so a freshly-renamed Spec doesn't need a per-Brief row.

export type BriefToSpecRedirect = {
  /** New canonical path with `/specs/spec-N/...` shape. */
  destination: string;
  /** Always 301 (permanent) per dec-6 / std-10. */
  status: 301;
  /** Stable reason code matching the `RedirectReason` enum. */
  reason: "brief_to_spec_rename";
};

// Path patterns, in declaration order. The doc-only pattern is listed last so
// the more-specific child patterns win first.
const BRIEF_TO_SPEC_PATTERNS: Array<{
  source: RegExp;
  destination: (m: RegExpExecArray) => string;
}> = [
  // 1. /<ns>/<mx>/briefs/b-N/decisions/dec-M → /<ns>/<mx>/specs/spec-N/decisions/dec-M
  {
    source: /^([^/]+)\/([^/]+)\/briefs\/b-(\d+)\/decisions\/(dec-\d+)$/,
    destination: (m) => `${m[1]}/${m[2]}/specs/spec-${m[3]}/decisions/${m[4]}`,
  },
  // 2. /<ns>/<mx>/briefs/b-N/tasks/t-M → /<ns>/<mx>/specs/spec-N/tasks/t-M
  {
    source: /^([^/]+)\/([^/]+)\/briefs\/b-(\d+)\/tasks\/(t-\d+)$/,
    destination: (m) => `${m[1]}/${m[2]}/specs/spec-${m[3]}/tasks/${m[4]}`,
  },
  // 3. /<ns>/<mx>/briefs/b-N/comments/c-M → /<ns>/<mx>/specs/spec-N/comments/c-M
  {
    source: /^([^/]+)\/([^/]+)\/briefs\/b-(\d+)\/comments\/(c-\d+)$/,
    destination: (m) => `${m[1]}/${m[2]}/specs/spec-${m[3]}/comments/${m[4]}`,
  },
  // 4. /<ns>/<mx>/briefs/b-N → /<ns>/<mx>/specs/spec-N (doc-only)
  {
    source: /^([^/]+)\/([^/]+)\/briefs\/b-(\d+)$/,
    destination: (m) => `${m[1]}/${m[2]}/specs/spec-${m[3]}`,
  },
  // 5. /<ns>/<mx>/briefs (the collection root used by the React UI list page)
  {
    source: /^([^/]+)\/([^/]+)\/briefs$/,
    destination: (m) => `${m[1]}/${m[2]}/specs`,
  },
];

/**
 * b-105 — translate an old `/briefs/b-N(/…)?` canonical path to its
 * `/specs/spec-N(/…)?` Spec equivalent. Returns `null` when the input is
 * already in Spec shape or doesn't match any of the five Brief patterns.
 *
 * Pure — no DB work, no awaitable side effects. Safe to call on the
 * resolver hot path; cost is one regex test per pattern.
 */
export function rewriteBriefPathToSpec(path: string): BriefToSpecRedirect | null {
  for (const { source, destination } of BRIEF_TO_SPEC_PATTERNS) {
    const m = source.exec(path);
    if (m) {
      return {
        destination: destination(m),
        status: 301,
        reason: "brief_to_spec_rename",
      };
    }
  }
  return null;
}

// spec-479 D-1 — a namespace/memex rename records ONE redirect row keyed on a
// PATH PREFIX, not a full entity ref: `namespace_rename` on the 1-segment
// namespace slug (`old-ns`), `memex_rename` on the 2-segment `<ns>/<mx>`
// (`old-ns/old-mx`). The resolver's prefix-match (`lookupOneStep`) rewrites
// every descendant path from it (std-10 §7, cl-84/85). Such a prefix is
// deliberately NOT a valid canonical ref (parseRef demands 4 or 6 segments),
// so it gets its own validator. Segments are checked against the slug-creation
// authority (`validateSlugFormat`) — NOT refs.ts's letter-first SLUG_RE —
// so a legitimate digit-leading slug (e.g. `2024-recap`) is accepted; and
// case-strictly, since old_path is stored lowercase and matched literally by
// the resolver's `LIKE old_path || '/%'`.
function assertRenamePrefix(
  path: string,
  segments: 1 | 2,
  argName: string,
  reason: RedirectReason
): void {
  const parts = path.split("/");
  if (parts.length !== segments) {
    throw new Error(
      `insertRedirect: ${reason} ${argName} "${path}" must have exactly ${segments} slug segment(s), got ${parts.length}`
    );
  }
  for (const seg of parts) {
    if (seg !== seg.toLowerCase() || !validateSlugFormat(seg).valid) {
      throw new Error(
        `insertRedirect: ${reason} ${argName} "${path}" has an invalid slug segment "${seg}"`
      );
    }
  }
}

// Record a redirect. UPSERT on the primary key so re-running the same move
// (e.g. a retried migration step) is a no-op rather than an error; `reason` +
// `created_at` are refreshed to reflect the latest event. Path validation is
// reason-gated: rename reasons store a prefix (see `assertRenamePrefix`);
// every other reason (a per-entity move) must be a full canonical ref.
export async function insertRedirect(
  oldPath: string,
  newPath: string,
  reason: RedirectReason,
  executor: SqlExecutor = db
): Promise<void> {
  if (reason === "namespace_rename" || reason === "memex_rename") {
    const segments = reason === "namespace_rename" ? 1 : 2;
    assertRenamePrefix(oldPath, segments, "oldPath", reason);
    assertRenamePrefix(newPath, segments, "newPath", reason);
  } else {
    const oldParse = parseRef(oldPath);
    if (!oldParse.ok) {
      throw new Error(`insertRedirect: invalid oldPath "${oldPath}": ${oldParse.reason}`);
    }
    const newParse = parseRef(newPath);
    if (!newParse.ok) {
      throw new Error(`insertRedirect: invalid newPath "${newPath}": ${newParse.reason}`);
    }
  }

  await executor.execute(sql`
    INSERT INTO redirects (old_path, new_path, reason)
    VALUES (${oldPath}, ${newPath}, ${reason})
    ON CONFLICT (old_path) DO UPDATE
       SET new_path   = excluded.new_path,
           reason     = excluded.reason,
           created_at = now()
  `);
}

// spec-479 D-4 reuse-guard — is `path` the SOURCE (old_path) of a live
// redirect? Because redirects never expire (std-10 cl-97), a slug a rename
// points away from must not be handed to a new/renamed entity: direct-first
// resolution (std-10 cl-91) would let the new entity shadow the redirect and
// silently mis-route every old link to the wrong place. Callers consult this
// before (re)registering a slug. old_path is the PK, so this is an index hit.
export async function isRedirectSource(path: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM redirects WHERE old_path = ${path} LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}
