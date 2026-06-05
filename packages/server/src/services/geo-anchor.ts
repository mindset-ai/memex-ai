// spec-100 (geo-comments): the pure string primitives behind anchored
// comments. No DB, no I/O — these run in plain Node and are the load-bearing
// core of the anchored-create flow (insert a marker into the section source),
// orphan detection (is the marker still there?), and snapshot capture (what
// was the commenter looking at?).
//
// dec-1 (amended): a comment anchors to a RANGE, marked by two footnote-style
// sentinels that ARE real characters of the markdown source — a start sentinel
// `[^c-{seq}s]` at the selection start and an end sentinel `[^c-{seq}e]` at the
// end. Both ride along with the text under every edit with no offset
// bookkeeping: insert before the pair → both shift; insert between them → the
// range simply grows to include the new text (the sensible reading of "this
// comment is about that region"). A bare `[^c-{seq}]` (no suffix) is a LEGACY
// point anchor — still recognised on read so old comments don't orphan, but
// never written by the current create flow. Everything here treats the
// sentinels as opaque text; there is no parsing of the surrounding markdown.

import { ValidationError } from "../types/errors.js";

// Legacy point glyph (no suffix). Retained for back-compat detection/stripping
// of comments created before the range model; not written by new comments.
export function markerGlyph(seq: number): string {
  return `[^c-${seq}]`;
}

// The range sentinels. `s` opens the anchored region, `e` closes it. The end
// sentinel is the canonical "is this comment still anchored?" token (it also
// renders as the clickable bubble client-side).
export function markerStartGlyph(seq: number): string {
  return `[^c-${seq}s]`;
}
export function markerEndGlyph(seq: number): string {
  return `[^c-${seq}e]`;
}

// Insert a marker glyph at a character offset in the section source. The offset
// is clamped into range so a stale/rounded client offset can never throw — it
// lands at the nearest valid boundary instead.
export function insertMarkerAt(content: string, offset: number, glyph: string): string {
  const at = Math.max(0, Math.min(offset, content.length));
  return content.slice(0, at) + glyph + content.slice(at);
}

// Matches ANY anchor marker glyph — range start `[^c-12s]`, range end
// `[^c-12e]`, or a legacy point `[^c-12]` — capturing the seq (group 1) and the
// optional suffix (group 2). Used to strip markers (whole-match replace) and to
// extract seqs (capture group); both therefore treat all three forms uniformly.
const MARKER_RE = /\[\^c-(\d+)([se]?)\]/g;

// Remove every anchor marker glyph (both sentinels + legacy point) from a run of
// source text. A snapshot or a rendered snippet should show the prose the reader
// sees, never the raw glyphs of neighbouring comments that share the region.
export function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, "");
}

// Remove just ONE comment's markers (start + end + legacy) — used on delete and
// on resolve-via-action, where the acted comment's own anchor is withdrawn but
// every other comment's sentinels must stay put.
export function stripMarkersForSeq(content: string, seq: number): string {
  return content.replace(new RegExp(`\\[\\^c-${seq}[se]?\\]`, "g"), "");
}

// Orphan-detection primitive: is this exact glyph still present in the source?
// Uses an exact-token match so `[^c-7]` is NOT considered present merely
// because `[^c-70]` is — the closing bracket guarantees no prefix collision,
// but we search for the full glyph (brackets included) to be explicit.
export function hasMarker(content: string, glyph: string): boolean {
  return content.includes(glyph);
}

// Is comment `seq` still anchored? True when its END sentinel is present (range
// model) OR its legacy point glyph is (back-compat). The start sentinel can be
// lost to an edit while the end survives — that degrades a range to a point but
// is not an orphan, so it is deliberately NOT required here.
export function hasAnchorMarker(content: string, seq: number): boolean {
  return content.includes(markerEndGlyph(seq)) || content.includes(markerGlyph(seq));
}

// A sentence boundary is `.`/`!`/`?` (optionally followed by whitespace) or a
// newline. Capture the sentence that contains `offset`, trimmed, capped at
// `maxLen` characters when the run has no nearby boundary (e.g. a long code
// block or table row). This is the snapshot stored on the comment at creation
// (dec-4) — what the commenter was actually looking at.
export function captureSnippet(content: string, offset: number, maxLen = 120): string {
  const at = Math.max(0, Math.min(offset, content.length));

  // Walk back to the start of the sentence: the character after the previous
  // boundary, or the start of the string.
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = content[i];
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      start = i + 1;
      break;
    }
  }

  // Walk forward to the end of the sentence: include the terminating
  // punctuation; stop at a newline (exclusive).
  let end = content.length;
  for (let i = at; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\n") {
      end = i;
      break;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      end = i + 1;
      break;
    }
  }

  // Strip any neighbouring markers, then collapse the whitespace they leave
  // behind, so the snapshot reads as clean prose.
  let snippet = stripMarkers(content.slice(start, end)).replace(/\s+/g, " ").trim();
  // Fallback: sentence detection can yield an empty slice (offset sits in a
  // whitespace/marker-only region, or right on a boundary). Never return empty
  // — an anchored comment must carry a snapshot — so widen to a window of
  // surrounding prose around the offset.
  if (!snippet) {
    const w0 = Math.max(0, at - maxLen);
    const w1 = Math.min(content.length, at + maxLen);
    snippet = stripMarkers(content.slice(w0, w1)).replace(/\s+/g, " ").trim();
  }
  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen).trimEnd();
  }
  return snippet;
}

// Snap an anchor offset to a word boundary so a marker never lands inside a
// word. If the offset falls between two word characters (mid-word), it is
// advanced to the end of that word; offsets already at a boundary are
// unchanged. Clamped into range.
export function snapToWordBoundary(content: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, content.length));
  const isWord = (ch: string | undefined): boolean => ch != null && /\w/.test(ch);
  if (isWord(content[at - 1]) && isWord(content[at])) {
    while (at < content.length && isWord(content[at])) at++;
  }
  return at;
}

// The mirror of `snapToWordBoundary` for a range START: if the offset falls
// mid-word, retreat to the START of that word so the opening sentinel never
// splits a word. Offsets already at a boundary are unchanged. Clamped.
export function snapToWordStart(content: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, content.length));
  const isWord = (ch: string | undefined): boolean => ch != null && /\w/.test(ch);
  if (isWord(content[at - 1]) && isWord(content[at])) {
    while (at > 0 && isWord(content[at - 1])) at--;
  }
  return at;
}

// Insert a comment's range sentinels around [startOffset, endOffset). The end
// sentinel is inserted FIRST (at the later offset) so placing the start sentinel
// can't shift the end's position out from under it. Offsets are clamped and the
// start is never allowed past the end, so the result is always a well-formed
// `…[^c-Ns]<selected>[^c-Ne]…`.
export function insertRangeMarkers(
  content: string,
  startOffset: number,
  endOffset: number,
  seq: number,
): string {
  const start = Math.max(0, Math.min(startOffset, content.length));
  const end = Math.max(start, Math.min(endOffset, content.length));
  const withEnd = insertMarkerAt(content, end, markerEndGlyph(seq));
  return insertMarkerAt(withEnd, start, markerStartGlyph(seq));
}

// The snapshot (dec-4) for a RANGE anchor: the selected text itself, stripped of
// any neighbouring markers and whitespace-collapsed, capped at `maxLen`. Falls
// back to the sentence around the end offset when the selection is empty/blank
// (so an anchored comment always carries a non-empty snapshot).
export function captureRangeSnippet(
  content: string,
  startOffset: number,
  endOffset: number,
  maxLen = 120,
): string {
  const start = Math.max(0, Math.min(startOffset, content.length));
  const end = Math.max(start, Math.min(endOffset, content.length));
  let snippet = stripMarkers(content.slice(start, end)).replace(/\s+/g, " ").trim();
  if (!snippet) {
    snippet = captureSnippet(content, end, maxLen);
  }
  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen).trimEnd();
  }
  return snippet;
}

// ── Marker preservation (spec §3) ───────────────────────────
// When an agent rewrites a paragraph, the markers of OTHER comments embedded in
// that paragraph must survive. The spec commits to a presence gate (no input
// marker missing from the output, else fail loudly). We also expose a
// position-drift detector: presence alone is insufficient because a marker can
// survive the edit yet silently re-attach to a different sentence, which is
// worse than an orphan (it reads as anchored but points at the wrong text).

// Every distinct marker seq present in the content, sorted ascending.
export function extractMarkerSeqs(content: string): number[] {
  const seqs = new Set<number>();
  for (const m of content.matchAll(MARKER_RE)) {
    seqs.add(Number(m[1]));
  }
  return [...seqs].sort((a, b) => a - b);
}

// Markers present in `before` but absent from `after` — the ones an edit
// destroyed. New markers added in `after` are irrelevant here.
export function findDestroyedMarkers(before: string, after: string): number[] {
  const afterSet = new Set(extractMarkerSeqs(after));
  return extractMarkerSeqs(before).filter((seq) => !afterSet.has(seq));
}

// The fail-loudly enforcement: if an edit would destroy any marker, throw
// rather than commit. The call site (agent action) leaves the spec unmodified
// and surfaces the error in the comment thread.
export function assertMarkersPreserved(before: string, after: string): void {
  const destroyed = findDestroyedMarkers(before, after);
  if (destroyed.length > 0) {
    const list = destroyed.map((seq) => `c-${seq}`).join(", ");
    throw new ValidationError(
      `Edit would destroy anchor marker(s): ${list}. The change was not applied so existing comments keep their anchors.`,
    );
  }
}

// The stripped sentence a given marker sits in. Used to compare a marker's
// anchored context before and after an edit.
function sentenceForMarker(content: string, seq: number): string | null {
  // Anchor drift off the END sentinel (or the legacy point glyph) — the start
  // sentinel is advisory and may be absent.
  const idx = content.includes(markerEndGlyph(seq))
    ? content.indexOf(markerEndGlyph(seq))
    : content.indexOf(markerGlyph(seq));
  if (idx < 0) return null;
  return captureSnippet(content, idx);
}

// Markers that survive an edit but whose anchored sentence changed. Advisory
// (not a hard gate): the caller decides whether to warn, re-snapshot, or flag a
// comment for review. Only considers markers present in BOTH before and after.
export function findDriftedMarkers(before: string, after: string): number[] {
  const survivors = extractMarkerSeqs(before).filter((seq) =>
    hasAnchorMarker(after, seq),
  );
  return survivors.filter((seq) => sentenceForMarker(before, seq) !== sentenceForMarker(after, seq));
}
