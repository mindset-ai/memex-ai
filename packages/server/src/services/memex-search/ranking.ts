// Ranking concern (spec-363 sol-7: god-module split). Reciprocal-rank-fusion
// merge of the FTS + vector arms into one ordered MemexSearchHit[]: the RRF
// constant, the accumulator that groups section rows under their parent doc (and
// keeps decisions/issues atomic), the snippet pickers, and the final score-sort
// + limit. No DB, no formatting — pure in-memory ranking over rows the retrieval
// layer fetched. Moved verbatim from memex-search.ts.

import { buildDecisionPath, buildDocPath, buildIssuePath, kindForDocType } from "./refs.js";
import { toIso, toMillis } from "./time.js";
import type {
  DecisionRow,
  IssueRow,
  MatchingSection,
  MemexSearchHit,
  MemexSearchKind,
  MemexSlugs,
  SearchStrategy,
  SectionRow,
} from "./types.js";

// Reciprocal-rank-fusion constant. 60 is the canonical default from the
// original Cormack/Clarke 2009 paper. Lower k weights top ranks more heavily,
// higher k flattens the curve. Keep at 60 unless we have measurements that
// disagree.
const RRF_K = 60;

interface AccumulatorEntry {
  id: string;
  parentDocId: string;
  kind: MemexSearchKind;
  path: string;
  title: string;
  status: string;
  score: number;
  strategies: Set<SearchStrategy>;
  sectionsByVia: Map<string, MatchingSection>;
  decisionSnippet?: string;
  decisionMatchedVia?: SearchStrategy;
  issueSnippet?: string;
  issueMatchedVia?: SearchStrategy;
  issueType?: string;
  // spec-285 WHO/WHEN. For a doc hit these track the most-recently-updated
  // matched section (so `authorAt` is the latest-section comparison key); for
  // decision/issue hits they're set once from the atomic row.
  authorName: string | null;
  lastUpdatedAt: string | null;
  /** Epoch millis of `lastUpdatedAt`, kept only to pick the latest matched
   *  section across the FTS + vector arms. Not emitted. */
  authorAtMillis: number;
  /** spec-521 dec-7 (ac-9): content-age timestamp + which timestamp it is. Tracked
   *  alongside the byline's WHO/WHEN because they answer different questions —
   *  "who touched this" versus "how old is what I am about to read". */
  recencyAt: string | null;
  recencyVerb: "resolved" | "updated";
}

function pickDecisionSnippet(r: DecisionRow): string {
  // Prefer resolution → context → title for the snippet body. Cap at 300 chars
  // (b-34 D-4).
  const candidate =
    (r.dec_resolution && r.dec_resolution.trim()) ||
    (r.dec_context && r.dec_context.trim()) ||
    r.dec_title;
  return candidate.length > 300 ? `${candidate.slice(0, 297)}…` : candidate;
}

function pickIssueSnippet(r: IssueRow): string {
  // Prefer body → title for the snippet body (an Issue's body carries the
  // detail; the title is the one-liner). Cap at 300 chars (b-34 D-4).
  const candidate =
    (r.issue_body && r.issue_body.trim()) || r.issue_title;
  return candidate.length > 300 ? `${candidate.slice(0, 297)}…` : candidate;
}

export function mergeWithRrf(
  sectionFts: SectionRow[],
  sectionVector: SectionRow[],
  decisionFts: DecisionRow[],
  decisionVector: DecisionRow[],
  issueFts: IssueRow[],
  issueVector: IssueRow[],
  slugs: MemexSlugs,
  limit: number,
): MemexSearchHit[] {
  // Sections: keyed by doc_id (group multiple matching sections under one
  // parent doc). Decisions: keyed by decision_id (atomic).
  const acc = new Map<string, AccumulatorEntry>();

  function addSectionRows(rows: SectionRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`doc:${r.doc_id}`);
      if (!entry) {
        entry = {
          id: r.doc_id,
          parentDocId: r.doc_id,
          kind: kindForDocType(r.doc_type),
          path: buildDocPath(slugs, r.doc_type, r.doc_handle),
          title: r.doc_title,
          status: r.doc_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
          authorName: null,
          lastUpdatedAt: null,
          authorAtMillis: -Infinity,
          // Doc hits: content age is LAST-UPDATED (ac-9). Filled in below as matched
          // sections arrive, alongside the byline's latest-section tracking.
          recencyAt: null,
          recencyVerb: "updated",
        };
        acc.set(`doc:${r.doc_id}`, entry);
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);

      // WHO/WHEN (spec-285): a doc hit groups many matched sections (and arrives
      // across the FTS + vector arms in rank order, not time order). Attribute
      // the doc to its MOST-RECENTLY-UPDATED matched section, so authorName +
      // lastUpdatedAt answer "who last changed this and when".
      const rowMillis = toMillis(r.updated_at);
      if (rowMillis > entry.authorAtMillis) {
        entry.authorAtMillis = rowMillis;
        // ac-9: a doc's content age tracks its most recently updated matched section,
        // the same row the byline attributes to.
        entry.recencyAt = toIso(r.updated_at);
        entry.authorName = r.author_name?.trim() || null;
        entry.lastUpdatedAt = toIso(r.updated_at);
      }

      // Keep the FIRST `via` that surfaced each section so a section seen by
      // both FTS and vector reports the higher-confidence search method.
      if (!entry.sectionsByVia.has(r.section_id)) {
        entry.sectionsByVia.set(r.section_id, {
          id: r.section_id,
          sectionType: r.section_type,
          title: r.section_title,
          content: r.section_content,
          matchedVia: via,
          // spec-259 ac-9: per-section WHO/WHEN so each matched section's own
          // creator surfaces, not just the doc-level most-recent one.
          authorName: r.author_name?.trim() || null,
          lastUpdatedAt: toIso(r.updated_at),
        });
      }
    }
  }

  function addDecisionRows(rows: DecisionRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`dec:${r.decision_id}`);
      if (!entry) {
        entry = {
          id: r.decision_id,
          parentDocId: r.doc_id,
          kind: "decision",
          path: buildDecisionPath(slugs, r.doc_type, r.doc_handle, r.dec_seq),
          title: r.dec_title,
          status: r.dec_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
          decisionSnippet: pickDecisionSnippet(r),
          decisionMatchedVia: via,
          // WHO/WHEN (spec-285): a decision is atomic, so set once. authorName =
          // denormalised actor_name (or resolved actor), lastUpdatedAt =
          // created_at (decisions carry no updated_at — dec-2 fallback).
          authorName: r.author_name?.trim() || null,
          lastUpdatedAt: toIso(r.created_at),
          authorAtMillis: toMillis(r.created_at),
          // spec-521 ac-9: a DECISION's content age is when it was RESOLVED — that is
          // the moment its content became the answer. An unresolved decision has no
          // resolution to age, so it falls back to created_at and says `updated`
          // rather than claiming a resolution that has not happened.
          recencyAt: toIso(r.resolved_at) ?? toIso(r.created_at),
          recencyVerb: r.resolved_at ? "resolved" : "updated",
        };
        acc.set(`dec:${r.decision_id}`, entry);
      } else {
        // Already present from the other arm — preserve original snippet/via
        // (first-wins), but boost the score.
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);
    }
  }

  function addIssueRows(rows: IssueRow[], via: SearchStrategy): void {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rrfContribution = 1 / (RRF_K + i + 1);
      let entry = acc.get(`iss:${r.issue_id}`);
      if (!entry) {
        entry = {
          id: r.issue_id,
          parentDocId: r.doc_id,
          kind: "issue",
          path: buildIssuePath(slugs, r.doc_type, r.doc_handle, r.issue_seq),
          title: r.issue_title,
          status: r.issue_status,
          score: 0,
          strategies: new Set<SearchStrategy>(),
          sectionsByVia: new Map(),
          issueSnippet: pickIssueSnippet(r),
          issueMatchedVia: via,
          issueType: r.issue_type,
          // WHO/WHEN (spec-285): atomic, set once. Issues have no actor_name, so
          // authorName is the resolved created_by user; lastUpdatedAt = updated_at.
          authorName: r.author_name?.trim() || null,
          lastUpdatedAt: toIso(r.updated_at),
          authorAtMillis: toMillis(r.updated_at),
          recencyAt: toIso(r.updated_at),
          recencyVerb: "updated",
        };
        acc.set(`iss:${r.issue_id}`, entry);
      } else {
        // Already present from the other arm — preserve original snippet/via
        // (first-wins), but boost the score. Mirrors addDecisionRows.
      }
      entry.score += rrfContribution;
      entry.strategies.add(via);
    }
  }

  addSectionRows(sectionFts, "fts");
  addSectionRows(sectionVector, "vector");
  addDecisionRows(decisionFts, "fts");
  addDecisionRows(decisionVector, "vector");
  addIssueRows(issueFts, "fts");
  addIssueRows(issueVector, "vector");

  const results: MemexSearchHit[] = Array.from(acc.values()).map((e) => ({
    id: e.id,
    kind: e.kind,
    path: e.path,
    parentDocId: e.parentDocId,
    title: e.title,
    status: e.status,
    score: e.score,
    strategies: Array.from(e.strategies).sort(),
    matchingSections: Array.from(e.sectionsByVia.values()),
    decisionSnippet: e.decisionSnippet,
    decisionMatchedVia: e.decisionMatchedVia,
    issueSnippet: e.issueSnippet,
    issueMatchedVia: e.issueMatchedVia,
    issueType: e.issueType,
    authorName: e.authorName,
    lastUpdatedAt: e.lastUpdatedAt,
    recencyAt: e.recencyAt,
    recencyVerb: e.recencyVerb,
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
