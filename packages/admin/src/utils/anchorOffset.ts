// spec-100: map a rendered text selection to a character offset in the markdown
// SOURCE — by POSITION, not by matching text.
//
// Text-fingerprinting (`source.indexOf(selectedText)`) is ambiguous: a short or
// repeated selection resolves to the wrong occurrence, and it breaks entirely
// when the selection spans inline markdown (the rendered "the bold word" never
// equals the source "the **bold** word"). Both failures are silent-wrong.
//
// Instead we use *where* the user selected. The rendered text the user sees is a
// SUBSEQUENCE of the markdown source — markup only ADDS characters (`**`, `` ` ``,
// `[`/`]`/`(`/`)`, `[^c-N]` markers, …). So we walk source and rendered in
// lockstep: when chars match we advance both; where the source has an extra
// markup char the rendered text doesn't, we skip it in the source. Whitespace is
// treated flexibly (markdown collapses runs of whitespace/newlines to a space).
// This yields an unambiguous source offset for any rendered offset — no
// fingerprint, no "which occurrence", formatting-agnostic.

const isWs = (c: string | undefined): boolean => c != null && /\s/.test(c);

/**
 * Translate an offset within the section's RENDERED text into an offset within
 * the markdown SOURCE, by greedily aligning rendered as a subsequence of source.
 * `renderedOffset` is clamped into range.
 */
export function renderedOffsetToSource(source: string, rendered: string, renderedOffset: number): number {
  const target = Math.max(0, Math.min(renderedOffset, rendered.length));
  let i = 0; // source index
  let j = 0; // rendered index
  while (i < source.length && j < target) {
    const sc = source[i];
    const rc = rendered[j];
    if (sc === rc || (isWs(sc) && isWs(rc))) {
      i++;
      j++;
      continue;
    }
    // Source has an extra markup (or whitespace) character not present in the
    // rendered text at this position — skip it and keep aligning.
    i++;
  }
  return i;
}

/**
 * Resolve a DOM Range boundary (container + offset) to an index in the flattened
 * RENDERED text described by `starts` (each accepted text node's cumulative
 * start index). This is the first half of mapping a selection to a source
 * offset: turn a `(container, offset)` boundary into a rendered offset, which
 * `renderedOffsetToSource` then maps into the markdown source.
 *
 * Text-node containers map directly. Element containers (a selection that begins
 * or ends on an element edge, e.g. the start of a bolded run) resolve to the
 * first accepted text node at/after the boundary, so such selections still
 * anchor correctly rather than being dropped. Returns -1 when the boundary sits
 * in rejected content (e.g. inside a marker badge that the walker skipped).
 */
export function resolveRenderedOffset(
  container: Node,
  domOffset: number,
  starts: { node: Node; start: number }[],
  totalLen: number,
): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = starts.find((s) => s.node === container);
    return entry ? entry.start + domOffset : -1;
  }
  const after = container.childNodes[domOffset] ?? null;
  if (!after) return totalLen; // boundary past the last child → end of text
  const entry = starts.find((s) => s.node === after || (after.contains?.(s.node) ?? false));
  return entry ? entry.start : totalLen;
}
