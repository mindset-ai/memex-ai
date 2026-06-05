// GET /api/:namespace/:memex/search — REST surface over the unified Memex
// search (spec-64 t-1). `searchMemex` (services/memex-search.ts) already does
// the handle + Postgres FTS + pgvector(RRF) work and is exposed via the MCP
// `search_memex` tool; this route is a thin HTTP mirror of that core for the
// React UI's omnibox. It does NOT touch the MCP path or formatSearchResults.
//
// Response envelope (spec-64 t-1 ac-6): `{ jumpTo, assigned, content }`.
//   - content  — MemexSearchHit[] from searchMemex, projected to the public
//                shape (UUIDs stripped per ac-7).
//   - jumpTo   — spec-64 t-2 (ac-17/ac-18): exact handle resolution
//                (spec-N/std-N/doc-N) + case-insensitive Spec title-substring,
//                via services/memex-search.ts:resolveJumpTo. Same public,
//                UUID-stripped shape as content.
//   - assigned — spec-64 t-2 (ac-19): for an `@<name>` query only, the Specs
//                assigned (spec-118 doc_assignees) to the matched member(s).
//                Non-`@` queries → []. Resolves the name to active org members
//                the way the Specs board labels a person (users.ts) — never
//                branches on the caller, so it works for anonymous public-memex
//                reads too (public-read contract preserved).
//
// Read-only surface (search never mutates), so it sits behind the PERMISSIVE
// publicSessionMiddleware + resolveReadableMemexId, exactly like the GET read
// handlers in routes/documents.ts:
//   - public memex  → anyone (incl. anonymous) searches.
//   - private memex → non-member / anonymous get 404 (std-7).
//   - unknown namespace/memex → 404 at memexResolver (std-7), before this runs.

import { Hono } from "hono";
import { publicSessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";
import { ValidationError } from "../types/errors.js";
import {
  searchMemex,
  resolveJumpTo,
  resolveAssignedSpecs,
  type MemexSearchHit,
  type MemexSearchKind,
} from "../services/memex-search.js";
import { getOrgIdForMemex } from "../services/memexes.js";
import { resolveOrgMembersByName } from "../services/users.js";

type Env = MemexResolverEnv & SessionEnv;
const search = new Hono<Env>();

// Search is a read. Mirror the documents.ts GET stack: permissive session +
// read-gate. No mutating verbs live on this router.
search.on("GET", "/*", publicSessionMiddleware);

// The user-facing `kind` vocabulary searchMemex accepts (services/memex-search.ts
// MemexSearchKind). An out-of-vocab `?kind=` is a client error → 400 rather than
// silently searching everything (the omnibox controls this param).
const VALID_KINDS: readonly MemexSearchKind[] = [
  "spec",
  "standard",
  "document",
  "decision",
  "issue",
];

function isValidKind(value: string): value is MemexSearchKind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

// spec-64 t-1 (ac-7): the wire shape for a content hit. The MemexSearchHit
// public fields ONLY — `id` and `parentDocId` (internal UUIDs) are stripped,
// matching the no-UUID rule the MCP formatter already enforces (b-36 D-7).
export type SearchContentHit = Omit<MemexSearchHit, "id" | "parentDocId">;

// spec-64 t-1 (ac-7): project a MemexSearchHit onto the public content shape by
// dropping the internal UUID fields. Every other field (kind, path, title,
// status, score, strategies, matchingSections, and the decision/issue snippet
// fields) passes through untouched.
function toContentHit(hit: MemexSearchHit): SearchContentHit {
  const { id: _id, parentDocId: _parentDocId, ...publicFields } = hit;
  return publicFields;
}

// spec-64 t-2 (ac-19): detect the `@<name>` shape that drives the assigned lane.
// Returns the trimmed name (sans `@`) for an `@`-prefixed query, else null (the
// lane stays empty). A bare `@` with no name → null (nothing to resolve).
function parseAssigneeQuery(query: string): string | null {
  const trimmed = (query ?? "").trim();
  if (!trimmed.startsWith("@")) return null;
  const name = trimmed.slice(1).trim();
  return name.length > 0 ? name : null;
}

// spec-64 t-1 (ac-6/ac-7): GET /api/:namespace/:memex/search?q=&kind=&limit=
search.get("/", async (c) => {
  // resolveReadableMemexId returns the member memex when the caller is a member,
  // else gates the path memex on canReadMemex (public → read, private → 404).
  // An unknown namespace/memex never reaches here — memexResolver 404s first.
  const memexId = await resolveReadableMemexId(c);

  const query = c.req.query("q") ?? "";

  // spec-64 t-1 (ac-7): forward `kind` to searchMemex. Unknown kind → 400.
  const kindParam = c.req.query("kind");
  let kind: MemexSearchKind | undefined;
  if (kindParam !== undefined && kindParam.length > 0) {
    if (!isValidKind(kindParam)) {
      throw new ValidationError(
        `Invalid kind '${kindParam}' — must be one of: ${VALID_KINDS.join(", ")}`,
      );
    }
    kind = kindParam;
  }

  // spec-64 t-1 (ac-7): forward `limit` to searchMemex. Must be a positive
  // integer when present; otherwise let searchMemex apply its own default (8).
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new ValidationError(
        `Invalid limit '${limitParam}' — must be a positive integer.`,
      );
    }
    limit = parsed;
  }

  // spec-64 t-1 (ac-11/ac-13/ac-14): apply NO status filter and NO
  // includeArchived — searchMemex already returns drafts (ac-13), excludes
  // archived/paused (ac-14), and falls back to FTS-only when no embedding
  // provider is configured (ac-11). We forward only `kind` + `limit`; the
  // provider is resolved inside searchMemex from env (omitted here).
  //
  // spec-64 t-2 (ac-17/ac-18/ac-19): resolve the jumpTo + assigned lanes
  // alongside the content tier. jumpTo (handle + Spec title-substring) is
  // independent of the caller; assigned is keyed off the `@<name>` token, never
  // off the caller's identity (so `c.get("currentUserId")` — which may be null
  // for an anonymous public-memex read — is deliberately not consulted; the
  // public-read contract holds, returning empty rather than 401). Run content +
  // jumpTo in parallel since neither depends on the other.
  const [hits, jumpToHits] = await Promise.all([
    searchMemex(memexId, query, { kind, limit }),
    resolveJumpTo(memexId, query),
  ]);

  // spec-64 t-2 (ac-19): the `assigned` lane is populated ONLY for an `@<name>`
  // query. Resolve the name to active org member(s) the same way the Specs board
  // labels a person (users.ts:resolveOrgMembersByName), then return the Specs
  // assigned to them via the spec-118 doc_assignees relation. Non-`@` queries →
  // []. A personal memex with no owning org, or a name that matches nobody →
  // []. Anonymous callers are NOT special-cased here: `@<name>` names a specific
  // person, not the caller, so it works for anonymous public-memex reads too —
  // we never branch on currentUserId for this lane (the public-read contract is
  // preserved: no 401, just data scoped to the resolved memex).
  let assignedHits: MemexSearchHit[] = [];
  const assigneeName = parseAssigneeQuery(query);
  if (assigneeName !== null) {
    const orgId = await getOrgIdForMemex(memexId);
    if (orgId) {
      const members = await resolveOrgMembersByName(orgId, assigneeName);
      assignedHits = await resolveAssignedSpecs(
        memexId,
        members.map((m) => m.userId),
      );
    }
  }

  // spec-64 t-1 (ac-6) / t-2 (ac-17/ac-18/ac-19): the
  // `{ jumpTo, assigned, content }` envelope. All three lanes share the public,
  // UUID-stripped content shape (toContentHit) so the client renders them
  // uniformly.
  return c.json({
    jumpTo: jumpToHits.map(toContentHit),
    assigned: assignedHits.map(toContentHit),
    content: hits.map(toContentHit),
  });
});

export { search };
