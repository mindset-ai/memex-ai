// spec-100 §4: the export / LLM form.
//
// A spec section has two markdown forms. The STORAGE form is what lives in
// Postgres: prose with bare `[^c-N]` marker glyphs, comments in a side table.
// The EXPORT form is a deterministic serialization of the storage form in
// which every marker is replaced, in situ, by an HTML-comment-delimited
// block-quote carrying the full comment thread. HTML comments are invisible in
// every standard renderer (GitHub, Slack, Notion, ChatGPT), and the
// block-quote is human-readable anywhere — so the same output serves the
// clipboard export, an external LLM paste, and the in-Memex side agent.
//
// This is a pure function over (sectionContent, comments). Round-tripping the
// export form back into storage is explicitly out of v0 scope.

import { stripMarkers } from "./geo-anchor.js";

// A narrow, DB-decoupled view of a comment for serialization. Callers project
// their DocComment rows down to this shape.
export interface ExportComment {
  seq: number;
  authorName: string;
  commentType: string;
  // null => open; a date => resolved (only the open/resolved distinction is
  // rendered, not the resolution timestamp).
  resolvedAt: Date | null;
  createdAt: Date;
  // null => the comment is floating (appended after the content rather than
  // expanded inline).
  anchorSnippet: string | null;
  content: string;
}

// Matches all three anchor forms: range start `[^c-Ns]`, range end `[^c-Ne]`,
// legacy point `[^c-N]`. The comment thread is expanded ONCE, at the end/point
// marker; a range's start sentinel is simply dropped (its thread rides on the
// end), so the export stays lossless and carries no leftover glyphs.
const MARKER_RE = /\[\^c-(\d+)([se]?)\]/g;

// YYYY-MM-DD in UTC — stable and renderer-agnostic.
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The block-quote header line: author, type, status, date, and (when anchored)
// the snapshot the comment was filed against.
function headerLine(c: ExportComment): string {
  const status = c.resolvedAt ? "resolved" : "open";
  const anchorClause = c.anchorSnippet ? `, anchored to: "${c.anchorSnippet}"` : "";
  return `**${c.authorName}** (${c.commentType}, ${status}, ${formatDate(c.createdAt)}${anchorClause})`;
}

// One comment rendered as an HTML-comment-delimited block-quote. Every line of
// the header + body is `> `-prefixed so the whole thing is a single markdown
// block-quote; the delimiters let a downstream parser find the exact span.
function commentBlock(c: ExportComment): string {
  const lines = [headerLine(c), ...c.content.split("\n")];
  const quoted = lines.map((l) => `> ${l}`).join("\n");
  return `<!-- comment-start c-${c.seq} -->\n${quoted}\n<!-- comment-end c-${c.seq} -->`;
}

export function serializeSectionToExportForm(
  content: string,
  comments: ExportComment[],
): string {
  const bySeq = new Map(comments.map((c) => [c.seq, c]));

  // Expand every anchored marker in place. A marker whose comment no longer
  // exists is dropped (rather than left as a dangling footnote reference).
  const expanded = content.replace(MARKER_RE, (_match, seqStr: string, suffix: string) => {
    if (suffix === "s") return ""; // range start sentinel — thread emits at the end
    const c = bySeq.get(Number(seqStr));
    return c ? commentBlock(c) : "";
  });

  // Floating comments (never anchored) are appended after the content, ordered
  // by seq, so the export is lossless — no comment silently disappears.
  const floating = comments
    .filter((c) => c.anchorSnippet === null)
    .sort((a, b) => a.seq - b.seq);

  if (floating.length === 0) {
    return expanded;
  }
  const floatingBlocks = floating.map(commentBlock).join("\n\n");
  // `stripMarkers` is a no-op here (markers already expanded) but guards
  // against a floating-only section that still carried an orphaned glyph.
  return `${stripMarkers(expanded)}\n\n${floatingBlocks}`;
}
