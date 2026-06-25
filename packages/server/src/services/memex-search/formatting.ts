// Formatting concern (spec-363 sol-7: god-module split). Renders a
// MemexSearchHit[] to the path-as-heading markdown spec (b-34 D-4): the heading
// line, the WHO/WHEN byline, the per-section / decision / issue snippet lines,
// and the open-comment indicator line. No DB, no ranking — pure presentation
// over already-ranked hits. Moved verbatim from memex-search.ts.

import { capitalizeDisplayName, timeAgo } from "@memex/shared";
import type { FormatOptions, MemexSearchHit } from "./types.js";

// ══════════════════════════════════════════════════════════
// Markdown formatter (b-34 D-4)
// ══════════════════════════════════════════════════════════
//
// Renders MemexSearchHit[] to the path-as-heading markdown spec:
//
//   ### <canonical-path> — "<title>" (<kind>, <status>)
//   - Section "<section-title>" (<fts|vector>):
//     > snippet ≤ 300 chars …
//
// For decisions:
//
//   ### …/specs/spec-N/decisions/dec-M — "<title>" (decision, <status>)
//   - (<fts|vector>): <snippet>
//
// No UUIDs anywhere (per b-36 D-2/D-7). Score / URL omitted in terse mode;
// `verbose: true` adds score for debug.

const SNIPPET_MAX_CHARS = 300;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// spec-285 + spec-259: the WHO/WHEN byline appended to a hit's heading, e.g.
// ` · Ryan Soosayraj, 3d ago`. Legible to a human and parseable by an agent
// (` · <author>, <relative-age>`). Degrades gracefully: author-only, age-only,
// or nothing at all when neither resolved. spec-259 dec-5 moved the RENDERED
// timestamp from an absolute YYYY-MM-DD to a relative `timeAgo()` ("Nd ago");
// the structured `hit.lastUpdatedAt`/`hit.authorName` stay absolute ISO. The
// author is run through capitalizeDisplayName (spec-259 ac-9) because the SQL
// WHO-resolver returns raw names that bypass the shared who-resolver. `now` is
// injectable so unit tests are deterministic.
function formatWhoWhenByline(
  authorName: string | null,
  lastUpdatedAt: string | null,
  now?: Date,
): string {
  const raw = authorName?.trim() || null;
  const author = raw ? capitalizeDisplayName(raw) : null;
  const age = lastUpdatedAt ? timeAgo(lastUpdatedAt, now) : null;
  if (author && age) return ` · ${author}, ${age}`;
  if (author) return ` · ${author}`;
  if (age) return ` · ${age}`;
  return "";
}

function formatHitByline(hit: MemexSearchHit, now?: Date): string {
  return formatWhoWhenByline(hit.authorName, hit.lastUpdatedAt, now);
}

// spec-259 ac-12: the open-comment indicator appended as its own line under a
// hit, e.g. `- (2 open comments, oldest 3d ago)`. Indicator only — no comment
// content. Returns null when the hit has zero open comments so the caller emits
// no line. `now` injectable for deterministic tests.
function formatOpenCommentsLine(hit: MemexSearchHit, now?: Date): string | null {
  const oc = hit.openComments;
  if (!oc || oc.count <= 0) return null;
  const noun = oc.count === 1 ? "open comment" : "open comments";
  return `- (${oc.count} ${noun}, oldest ${timeAgo(oc.oldestCreatedAt, now)})`;
}

function isHitOnCurrentDoc(hit: MemexSearchHit, currentDocId: string): boolean {
  // parentDocId is the doc UUID for section/doc hits and the parent Spec's
  // UUID for decision hits. Matching here means the hit belongs to the
  // Spec the agent is currently editing.
  return hit.parentDocId === currentDocId;
}

export function formatSearchResults(
  query: string,
  hits: MemexSearchHit[],
  options: FormatOptions = {},
): string {
  if (hits.length === 0) {
    return `No results for "${query}".`;
  }

  const verbose = options.verbose === true;
  const currentDocId = options.currentDocId;
  const now = options.now;
  const lines: string[] = [`## Search results for "${query}" (${hits.length} hit${hits.length === 1 ? "" : "s"})`];

  for (const hit of hits) {
    const scoreSuffix = verbose ? ` (score ${hit.score.toFixed(3)})` : "";
    const selfTag =
      currentDocId && isHitOnCurrentDoc(hit, currentDocId) ? " [current doc]" : "";
    lines.push("");
    // For issues, fold the bug/todo type into the kind segment of the heading
    // so a reader can tell a bug from a todo at a glance (spec-112 t-4).
    const kindLabel =
      hit.kind === "issue" && hit.issueType ? `issue/${hit.issueType}` : hit.kind;
    // spec-285: WHO/WHEN byline sits after the (kind, status) segment and before
    // the [current doc] / verbose-score suffixes, so an agent reading the result
    // can attribute the hit ("who, when") without opening it.
    const byline = formatHitByline(hit, now);
    lines.push(`### ${hit.path} — "${hit.title}" (${kindLabel}, ${hit.status})${byline}${selfTag}${scoreSuffix}`);
    if (hit.kind === "decision") {
      const via = hit.decisionMatchedVia ?? "fts";
      const snippet = hit.decisionSnippet ?? "";
      lines.push(`- (${via}): ${truncate(snippet, SNIPPET_MAX_CHARS)}`);
    } else if (hit.kind === "issue") {
      const via = hit.issueMatchedVia ?? "fts";
      const snippet = hit.issueSnippet ?? "";
      lines.push(`- (${via}): ${truncate(snippet, SNIPPET_MAX_CHARS)}`);
    } else {
      for (const sec of hit.matchingSections) {
        const titleSeg = sec.title ? `"${sec.title}"` : `(${sec.sectionType})`;
        const snippet = truncate((sec.content ?? "").trim(), SNIPPET_MAX_CHARS);
        // spec-259 ac-9: per-section WHO/WHEN so a multi-section doc hit surfaces
        // each matched section's own creator + relative age, not just the
        // doc-level latest. Same capitalize + timeAgo treatment as the heading.
        const secByline = formatWhoWhenByline(sec.authorName, sec.lastUpdatedAt, now);
        lines.push(`- Section ${titleSeg} (${sec.matchedVia})${secByline}:`);
        lines.push(`  > ${snippet}`);
      }
    }
    // spec-259 ac-12: one lightweight open-comment indicator line per hit (after
    // the snippet block). Rendered only when the hit has open comments.
    const openCommentsLine = formatOpenCommentsLine(hit, now);
    if (openCommentsLine) lines.push(openCommentsLine);
  }

  return lines.join("\n");
}
