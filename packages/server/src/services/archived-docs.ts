// spec-521 dec-2 (ac-2, ac-12) — the archived-document stub, shared by both agent
// surfaces.
//
// WHY THIS MODULE EXISTS. Archive was honoured on every path that FINDS things
// (search's seven retrieval tiers, listDocs, getDoc) and on no path that ADDRESSES
// things. An agent that never searched — one following a cross-reference in a live
// Spec's prose, or reusing a ref from earlier in the session — resolved straight
// into an archived Spec and read its parked decisions as current intent. The fix is
// one guard in the canonical resolver (services/resolver.ts, dec-1); this module
// owns the RESPONSE that guard produces.
//
// ONE stub shape, deliberately shared. dec-2 settled that both surfaces emit the
// same stub, so the formatter lives here rather than being written twice — the
// duplicated `isDemo` guard is the anti-pattern this Spec exists to correct, and
// copying the stub would repeat the mistake in a new place.

import type { Doc } from "../db/schema.js";

/**
 * spec-521 ac-12 / ac-2 — the archive reason is capped so the stub cannot become a
 * back door for the very content the archive withholds. Enforced at WRITE time in
 * the service layer (not by a DB constraint) so the caller gets a ValidationError
 * naming the limit. Shared with the supersession note, which is capped at the same
 * length for the same reason: a pointer, not a place to re-argue the Spec.
 */
export const ARCHIVE_REASON_MAX_LENGTH = 280;

/**
 * Absolute, human-readable archive date — "30 Jul 2026".
 *
 * Deliberately absolute rather than the relative `timeAgo()` the search byline
 * uses: the stub is a factual record of when someone put this work down, and "3w
 * ago" drifts every time it is read. UTC so the rendering never depends on the
 * reading server's timezone.
 */
function formatArchiveDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Render the archived-doc stub an agent gets when it resolves the DOC's own ref.
 *
 * BINDING CONTENT RULES (§5.2, ac-12) — six facts and nothing else:
 *   handle · title · archived-at · archiving actor · phase-at-archive · reason
 * plus a closing line naming the restore path.
 *
 * NEVER INCLUDED: narrative sections, decisions, ACs, tasks, issues, comments, and
 * — the easy one to get wrong — NO COUNTS of any of them. A count is itself a leak:
 * "9 open decisions" is an invitation to go looking, which is exactly the behaviour
 * the guard exists to stop.
 *
 * WHY A STUB AND NOT A 404 (dec-2). A hard not-found on the doc ref would make an
 * archived Spec indistinguishable from one that never existed, so an agent
 * following a dangling cross-reference would propose CREATING the work someone had
 * just deliberately parked. The stub names the Spec without serving it. Child refs
 * get the opposite treatment — a plain not-found — because at the child grain there
 * is nothing an agent needs beyond "no".
 *
 * PHASE-AT-ARCHIVE reads the doc's `status` directly. `archived_at` is orthogonal to
 * `status`, so archiving never changed the phase and the current value IS the phase
 * the doc was in when archived.
 *
 * Degrades honestly. Rows archived before spec-521 carry no reason and no actor, and
 * the stub says so rather than rendering "undefined" or silently dropping the line —
 * "not recorded" is a true statement about an old archive.
 *
 * std-34 / ac-16: the closing line states that a human can restore it in the archive
 * view AND that agents cannot. It names no MCP tool, because there is no archive or
 * restore tool on any agent surface — archiving withholds content and that judgement
 * stays with a person (dec-6). Telling an agent it could restore this would be
 * instructing a step that does not exist.
 */
export function formatArchivedDocStub(doc: Doc, docRef: string): string {
  const archivedAt = doc.archivedAt ? formatArchiveDate(doc.archivedAt) : "date not recorded";
  const actor = doc.archivedByName?.trim() || null;
  const byClause = actor ? ` by ${actor}` : "";
  const reason = doc.archiveReason?.trim() || null;

  return [
    `${docRef} — "${doc.title}"`,
    `ARCHIVED ${archivedAt}${byClause} · phase at archive: ${doc.status}`,
    `Reason: ${reason ?? "not recorded"}`,
    "Content withheld — no narrative, decisions, acceptance criteria or tasks are served for an archived Spec.",
    "A human can restore it in the archive view; agents cannot.",
  ].join("\n");
}
