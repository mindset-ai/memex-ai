// spec-100 (LOCATE side): given a comment's rendered marker(s), compute the DOM
// Range to paint as the amber anchor highlight. Pure DOM geometry, no CSS side
// effect, so it is unit-testable in jsdom (the caller wraps the returned Range
// in a CSS Custom Highlight).
//
// Two modes, mirroring the anchor model (dec-1 amended):
//   - RANGE: when a start sentinel exists, the highlight is exactly the span
//     between the start sentinel and the end bubble (the user's selection,
//     across paragraphs if need be).
//   - POINT / legacy: with no start sentinel, fall back to the sentence that
//     contains the marker, derived from the marker's live DOM position so it is
//     immune to inline markdown (bold/italic/code in the sentence).

const SENTENCE_END = (c: string): boolean => c === '.' || c === '!' || c === '?';
const isBoundary = (c: string): boolean => SENTENCE_END(c) || c === '\n';

// The sentence-containing-the-marker fallback. Flattens the marker's block text
// (skipping marker-badge text), finds where the marker sits, and returns a Range
// over the surrounding sentence. Returns null when no usable text is found.
function sentenceRange(endEl: Element): Range | null {
  const block = endEl.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote') ?? endEl.parentElement;
  if (!block) return null;

  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('[data-marker-seq]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let full = '';
  const map: { node: Node; offset: number }[] = [];
  let markerPos = -1;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    // The first text node that follows the marker fixes the marker's position.
    if (markerPos < 0 && endEl.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) {
      markerPos = full.length;
    }
    const t = n.textContent ?? '';
    for (let i = 0; i < t.length; i++) map.push({ node: n, offset: i });
    full += t;
  }
  if (markerPos < 0) markerPos = full.length; // marker trails all text

  let start = 0;
  for (let i = markerPos - 1; i >= 0; i--) {
    if (isBoundary(full[i])) {
      start = i + 1;
      break;
    }
  }
  let end = full.length;
  for (let i = markerPos; i < full.length; i++) {
    if (full[i] === '\n') {
      end = i;
      break;
    }
    if (SENTENCE_END(full[i])) {
      end = i + 1;
      break;
    }
  }
  while (start < end && /\s/.test(full[start])) start++;
  if (start >= end || !map[start] || !map[end - 1]) return null;

  const range = document.createRange();
  range.setStart(map[start].node, map[start].offset);
  range.setEnd(map[end - 1].node, map[end - 1].offset + 1);
  return range;
}

/**
 * The Range to highlight for a comment, given its end bubble element and its
 * (optional) start sentinel element. RANGE comments highlight the span between
 * the two sentinels; POINT / legacy comments (no start) highlight the marker's
 * sentence. Returns null when no Range can be built.
 */
export function buildAnchorRange(endEl: Element, startEl: Element | null): Range | null {
  if (startEl) {
    try {
      const r = document.createRange();
      r.setStartAfter(startEl); // just inside the selection's left edge
      r.setEndBefore(endEl); // just inside its right edge (before the bubble)
      return r;
    } catch {
      // Malformed/detached sentinel — fall through to the sentence heuristic.
    }
  }
  return sentenceRange(endEl);
}
