// spec-100 ac-6: stable deep-links to a specific comment.
//
// The link is the current document URL with a `?comment=c-{seq}` query param —
// the canonical `c-N` handle (std-1), so it survives across sessions and is
// human-legible. Pure helpers here; the scroll/highlight effect lives in the
// page, and the DOM scroll anchor id is `comment-c-{seq}`.

// The query-param key the doc page reads on load.
export const COMMENT_PARAM = 'comment';

// `c-{seq}` — the param value and the canonical handle.
export function commentHandle(seq: number): string {
  return `c-${seq}`;
}

// The DOM id used as the scroll target for a comment in the page.
export function commentAnchorId(seq: number): string {
  return `comment-c-${seq}`;
}

// Parse a `?comment=c-N` value back to a seq. Returns null for anything that
// isn't a well-formed `c-<positive-int>` handle.
export function parseCommentParam(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^c-(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const seq = Number(m[1]);
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

// Build the shareable absolute URL for a comment from a base href (typically
// the current document URL, with any existing query/hash stripped by the
// caller or preserved as desired). Existing params are kept; `comment` is set.
export function buildCommentLink(baseUrl: string, seq: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set(COMMENT_PARAM, commentHandle(seq));
  return url.toString();
}
