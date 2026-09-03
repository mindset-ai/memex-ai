// spec-546: Semantic overlap search between an Issue and the Specs or Decisions it might
// belong to, plus the nudge prose that reports a hit.
//
// Split out of agent/handlers/shared.ts (renamed tool-contract.ts in t-3)
// [per std-51: a module is named for its contents, never for the act that made it].

import {
  searchMemex,
} from "../../services/memex-search.js";

// spec-112 (ac-25/ac-27): rank the best-suited Specs to home a homeless Issue.
// Semantic search over the issue text (title + body) restricted to Specs
// (kind:'spec'). searchMemex already excludes archived + paused content; we
// additionally drop `done` so ONLY active-phase Specs are suggested. The vector
// arm of searchMemex runs whenever a provider is supplied — so this ranks via
// the vector path when embeddings are configured, and falls back to FTS-only
// otherwise (ac-27). Exported so the assist's ranking is unit-testable with an
// injected provider without driving the whole register_issue handler.
export async function suggestActiveSpecsForIssue(
  memexId: string,
  title: string,
  body: string,
  provider: import("../../services/embedding-provider.js").EmbeddingProvider | null,
  limit = 5,
): Promise<import("../../services/memex-search.js").MemexSearchHit[]> {
  const issueText = `${title}\n\n${body}`.trim();
  if (issueText.length === 0) return [];
  const hits = await searchMemex(memexId, issueText, {
    kind: "spec",
    provider,
    limit,
  });
  // searchMemex drops archived/paused already; exclude `done` so the
  // suggestions are active-phase Specs only (ac-27).
  return hits.filter((h) => h.status !== "done" && h.status !== "archived");
}

// spec-112 (ac-4 / ac-15): decision-time auto-surfacing of related Issues.
//
// When a decision is created or resolved, the JIT-nudge channel appends related
// Issues whose semantic overlap with the decision text clears a relevance
// threshold. This reuses the SAME searchMemex(kind:'issue') machinery the
// search_issues tool rides — no new search infra (s-4). It is INFORMATIONAL
// only: it never mutates, never blocks a phase move, and below threshold it
// appends nothing.
//
// Relevance threshold. searchMemex merges an FTS arm and a vector arm via RRF.
// The vector arm is rank-only — it returns EVERY embedded Issue ordered by
// cosine distance with no distance cutoff (see runIssueVector), so a
// vector-only hit is not by itself evidence of relevance, and adjacent
// post-RRF scores are nearly identical (1/(K+i) for consecutive ranks). The
// genuine relevance gate is therefore the FTS arm: `@@ plainto_tsquery` only
// matches Issues that share content terms with the decision text. So the
// threshold is "the hit must have been surfaced by FTS" — a real lexical
// overlap — and, among those, we keep hits whose score is at least
// RELATED_ISSUE_SCORE_RATIO of the top FTS-backed hit (a secondary trim that
// drops far-weaker partial matches). Below the gate, nothing is appended.
const RELATED_ISSUE_SCORE_RATIO = 0.5;

const RELATED_ISSUE_LIMIT = 3;

// Search Issues across the whole Memex (cross-Spec) for ones whose text overlaps
// the decision, keeping only those above the relevance threshold. Exported so the
// threshold behaviour is unit-testable with an injected provider (ac-15) without
// driving a whole create/resolve_decision handler.
export async function relatedIssuesForDecision(
  memexId: string,
  decisionText: string,
  provider: import("../../services/embedding-provider.js").EmbeddingProvider | null,
  limit = RELATED_ISSUE_LIMIT,
): Promise<import("../../services/memex-search.js").MemexSearchHit[]> {
  const text = decisionText.trim();
  if (text.length === 0) return [];
  const hits = await searchMemex(memexId, text, {
    kind: "issue",
    provider,
    // Pull a few extra so the ratio trim has a population to cut against, then
    // trim to `limit` after thresholding.
    limit: Math.max(limit * 2, limit),
  });
  if (hits.length === 0) return [];
  // searchMemex already drops resolved-Spec / archived noise at the doc level;
  // exclude resolved Issues so a closed bug/todo never resurfaces as "related".
  // The relevance gate: the hit must carry a real lexical overlap (FTS), not be
  // a vector-only rank artefact (every embedded Issue rides the vector arm).
  const related = hits.filter(
    (h) => h.status !== "resolved" && h.strategies.includes("fts"),
  );
  if (related.length === 0) return [];
  const top = related[0].score;
  const floor = top * RELATED_ISSUE_SCORE_RATIO;
  return related.filter((h) => h.score >= floor).slice(0, limit);
}

// Compose the informational JIT-nudge tail that lists related Issues by their
// cross-Spec canonical ref (hit.path). Returns "" when there are none above
// threshold, so callers can append unconditionally. Informational only.
export function relatedIssuesNudge(
  hits: import("../../services/memex-search.js").MemexSearchHit[],
): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => {
    const typeTag = h.issueType ? `${h.issueType}` : "issue";
    return `  - ${h.path} — "${h.title}" (${typeTag}, ${h.status})`;
  });
  return (
    `\n\nRelated Issues (informational — may inform this decision; nothing was changed):\n` +
    lines.join("\n") +
    `\nReview with \`get_issue({ ref: '<one of the above>' })\`; pull one into the work with \`create_task\` if it bears on this decision.`
  );
}
