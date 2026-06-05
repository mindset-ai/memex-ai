// spec-158 t-1: one-time rewrite of the legacy issue child handle `i-N` → `issue-N`
// inside stored free-text bodies (doc_sections.content + doc_comments.content).
//
// Per dec-3 this is a HARD cutover with no backwards-compat alias — the product is
// unreleased, so we don't keep `i-N` readable. The canonical handle changed shape
// (services/refs.ts CHILD_HANDLE_PREFIX), so any literal `i-N` issue token already
// sitting in a stored body would dangle (the parser no longer accepts it). This
// helper is the migration's transform, extracted so it's unit-testable without a DB.
//
// CONSERVATIVE BY DESIGN. `i-N` is a dangerously generic token — it collides with
// ordinary prose ("i-beam", "wi-fi"), with other handles only by accident, and with
// nothing the rewrite should touch outside the two shapes the server itself emits:
//
//   1. The canonical PATH form `<...>/issues/i-N` — unambiguous: the `/issues/`
//      segment proves the trailing `i-N` denotes an Issue. This is what
//      buildIssuePath / buildChildRef wrote into bodies (search results, refs).
//
//   2. The PROSE form `Issue i-N` / `issue i-N` — the exact string the conversion
//      path (services/issues.ts) folds into Task descriptions + AC statements
//      ("Converted from Issue i-3 ...", "The bug from Issue i-3 ..."). The leading
//      `Issue`/`issue` word makes the `i-N` unambiguous.
//
// Anything else — a bare `i-1` in arbitrary prose, `i-beam`, `wi-fi`, dec-3, t-1 —
// is LEFT ALONE. We never rewrite a `i-N` we can't prove is an issue handle.

// Path form: the `/issues/` segment anchors it. `\b` after the digits stops `i-12`
// from being half-rewritten when followed by more digits is impossible (\d+ is
// greedy) but guards a trailing word char (e.g. `i-3x`, which isn't a handle).
const ISSUE_PATH_RE = /\/issues\/i-(\d+)\b/g;

// Prose form: the literal word `Issue`/`issue`, a single space, then `i-N`. The
// leading `(^|[^A-Za-z])` keeps us from matching inside a longer word (e.g.
// "reissue i-3" would still match on the "issue" tail — acceptable, it IS an issue
// reference — but "dismissue" can't arise; the space before `i-` is required).
const ISSUE_PROSE_RE = /\b(Issue|issue) i-(\d+)\b/g;

/**
 * Rewrite every PROVABLE legacy issue handle `i-N` to `issue-N` inside a single
 * stored body string. Word-boundary-safe and conservative: only the canonical
 * `/issues/i-N` path form and the `Issue i-N` prose form are touched. Returns the
 * input unchanged when there's nothing to rewrite (so the migration can skip the
 * write for untouched rows).
 */
export function rewriteIssueHandlesInBody(body: string): string {
  return body
    .replace(ISSUE_PATH_RE, "/issues/issue-$1")
    .replace(ISSUE_PROSE_RE, "$1 issue-$2");
}
