export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Extract the trailing sequence number from a doc handle (e.g. `doc-5` → `5`).
 * Returns null when the handle has no numeric suffix.
 */
export function docSeq(handle: string): string | null {
  const match = handle.match(/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Reduce a markdown-bearing string to a single line of plain text for a search
 * snippet (spec-64 t-4 ac-20). The omnibox renders the result as TEXT (never as
 * markdown, never via the server's `formatSearchResults`), so this strips the
 * common inline/block markdown that would otherwise show its raw syntax:
 *   - fenced/inline code fences (``` and `)
 *   - heading hashes, blockquote `>` and list `-`/`*`/`1.` markers (line-leading)
 *   - bold/italic/strike emphasis runs (`**`, `__`, `*`, `_`, `~~`)
 *   - links/images → their visible label (`[text](url)` → `text`, `![alt]` → `alt`)
 *   - HTML tags (defence-in-depth; React already escapes, but we don't want the
 *     literal `<tag>` text leaking into the snippet)
 * then collapses whitespace and truncates to `max` chars (default 120) with an
 * ellipsis. The output is plain text — callers render it inside a text node, so
 * any residual characters are escaped by React, not interpreted.
 */
export function snippetText(input: string, max = 120): string {
  let text = (input ?? '')
    // Fenced code blocks → keep their inner text, drop the fences.
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    // Images then links → visible label only.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Strip any HTML tags (defence-in-depth).
    .replace(/<\/?[^>]+>/g, ' ')
    // Line-leading block markers: headings, blockquotes, list bullets/numbers.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
    // Emphasis runs (order matters: doubles before singles).
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/([*_])(.*?)\1/g, '$2')
    // Collapse all whitespace (incl. newlines) to single spaces.
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) {
    text = text.slice(0, max).trimEnd() + '…';
  }
  return text;
}
