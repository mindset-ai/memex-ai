// GET /api/:namespace/:memex/issues-list — the Memex-level Issues page feed
// (spec-158 t-3). Read-only roll-up of every OPEN issue across the Memex, joined
// to parent-Spec metadata so the React UI groups under the Spec in one
// round-trip. It does NOT touch the per-Spec issues surface (routes/issues.ts) —
// that one is anchored to a single Spec; this is the cross-Spec list.
//
// Org-membership gated (std-4): the Issues page is a member surface, so this
// sits behind STRICT sessionMiddleware — a non-member / anonymous request 404s
// before the handler runs (std-7, indistinguishable from non-existent), exactly
// like the Drift Inbox (routes/drift.ts). The service trusts the resolved
// memexId and re-asserts the memex_id filter in SQL.
//
// Query params (all optional, all compose):
//   ?scope=mine|all    — default 'mine' (issues on Specs assigned to the caller);
//                        'all' widens to the whole Memex (ac-12).
//   ?phases=specify,build  — comma-separated subset of draft/specify/build/verify/done;
//                        narrows on the parent Spec's status (ac-13). Unknown
//                        tokens are ignored; absent ⇒ all phases.
//   ?types=bug,todo     — comma-separated subset of bug/todo; narrows on the
//                        issue's type (ac-10). Unknown tokens ignored; absent ⇒
//                        all types.

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import {
  listMemexIssues,
  isSpecPhase,
  type IssueScope,
  type SpecPhase,
} from "../services/issues-list.js";
import { ISSUE_TYPES, type IssueType } from "../services/issues.js";

type Env = MemexResolverEnv & SessionEnv;
const issuesList = new Hono<Env>();
issuesList.use("/*", sessionMiddleware);

// Parse a comma-separated query param into a deduped, recognised subset. Unknown
// tokens are dropped (permissive — the UI controls these params); an absent or
// empty value yields an empty array, which the service reads as "no narrowing".
function parseCsv<T extends string>(raw: string | undefined, isValid: (v: string) => v is T): T[] {
  if (!raw) return [];
  const out = new Set<T>();
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (t && isValid(t)) out.add(t);
  }
  return [...out];
}

function isIssueTypeToken(value: string): value is IssueType {
  return (ISSUE_TYPES as readonly string[]).includes(value);
}

issuesList.get("/", async (c) => {
  const memexId = requireMemexId(c);
  const userId = (c.get("currentUserId") as string | null) ?? null;

  // scope defaults to 'mine'; any value other than the explicit 'all' falls back
  // to 'mine' (the safe, narrow default — never silently widen to the whole
  // Memex on a typo).
  const scope: IssueScope = c.req.query("scope") === "all" ? "all" : "mine";

  const phases: SpecPhase[] = parseCsv(c.req.query("phases"), isSpecPhase);
  const types: IssueType[] = parseCsv(c.req.query("types"), isIssueTypeToken);

  const items = await listMemexIssues(memexId, { scope, userId, phases, types });
  return c.json({ items });
});

export { issuesList };
