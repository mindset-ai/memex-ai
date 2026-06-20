// spec-319 dec-1: the pure half of detecting a comment-anchor selection inside a
// section body. Given a live DOM Range, the section's body element, and the
// markdown source, resolve the selection's two boundaries to SOURCE offsets and
// return the anchor descriptor — or null when the selection isn't a usable
// in-body anchor.
//
// This is split out of SectionCard so it is unit-testable in jsdom (no rect / no
// CSS): the WHERE-the-gesture-ends robustness is proven at the e2e tier, while
// the offset mapping + scoping live here where they can be exercised directly.
// Only the TRIGGER changed in dec-1 (onMouseUp → document selectionchange); this
// mapping is the same logic the old handleSelection ran, hardened to read the
// normalized Range (not sel.anchorNode), so backward selections resolve too.

import { renderedOffsetToSource, resolveRenderedOffset } from './anchorOffset';

export interface SelectionAnchor {
  /** Source-offset start of the selection (where `[^c-Ns]` will sit). */
  start: number;
  /** Source-offset end of the selection (where `[^c-Ne]` will sit). */
  end: number;
  /** Short rendered-text preview of the selection (≤60 chars). */
  quote: string;
}

/**
 * Resolve a selection Range to a section-source anchor, or null when it is not a
 * usable in-body selection (collapsed, empty, outside this body, or a boundary
 * that maps into stripped marker content).
 */
export function computeAnchorFromRange(
  range: Range,
  bodyEl: HTMLElement,
  source: string,
): SelectionAnchor | null {
  // Scope by CONTAINMENT, not by where the pointer was released: the selection
  // must live inside THIS section's body. This is what makes detection
  // independent of the gesture's end point (dec-1).
  if (!bodyEl.contains(range.commonAncestorContainer)) return null;

  const quote = range.toString().trim();
  if (!quote) return null;

  // Flatten the body's rendered text (skipping marker badges) into one string,
  // recording each text node's cumulative start index, then map the Range's
  // start and end boundaries to rendered offsets and on into the markdown source.
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('[data-marker-seq],[data-marker-start]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let rendered = '';
  const starts: { node: Node; start: number }[] = [];
  let wn: Node | null;
  while ((wn = walker.nextNode())) {
    starts.push({ node: wn, start: rendered.length });
    rendered += wn.textContent ?? '';
  }

  const renderedStart = resolveRenderedOffset(range.startContainer, range.startOffset, starts, rendered.length);
  const renderedEnd = resolveRenderedOffset(range.endContainer, range.endOffset, starts, rendered.length);
  if (renderedStart < 0 || renderedEnd < 0 || renderedEnd <= renderedStart) return null;

  const start = renderedOffsetToSource(source, rendered, renderedStart);
  const end = renderedOffsetToSource(source, rendered, renderedEnd);
  return { start, end, quote: quote.slice(0, 60) };
}
