import { describe, it, expect, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { computeAnchorFromRange } from './sectionSelection';

// spec-319 dec-1: the selection→anchor mapping is scoped by CONTAINMENT and reads
// the normalized Range, so a valid in-body selection always resolves to a source
// anchor regardless of how the gesture ended. (The release-point invariance
// itself is proven in the browser by journey-36; here we pin the pure logic.)
const AC_RELIABLE = 'mindset-prod/memex-building-itself/specs/spec-319/acs/ac-1';

function bodyWith(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('computeAnchorFromRange', () => {
  it('maps an in-body selection to its source offsets (rendered == source)', () => {
    tagAc(AC_RELIABLE);
    const source = 'The quick brown fox';
    const body = bodyWith(`<p>${source}</p>`);
    const tn = body.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(tn, 4); // 'q' of quick
    range.setEnd(tn, 15); // just after 'brown'

    const anchor = computeAnchorFromRange(range, body, source);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe('quick brown');
    expect(anchor!.start).toBe(4);
    expect(anchor!.end).toBe(15);
  });

  it('maps across inline markdown (rendered is a subsequence of source)', () => {
    tagAc(AC_RELIABLE);
    // Source carries `**` around "bold"; the rendered text the user selects does
    // not. The mapping must still land the source offsets on the right chars.
    const source = 'a **bold** word';
    const body = bodyWith('<p>a <strong>bold</strong> word</p>');
    const strongText = body.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(strongText, 0); // 'b'
    range.setEnd(strongText, 4); // after 'bold'

    const anchor = computeAnchorFromRange(range, body, source);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe('bold');
    // The rendered "bold" maps back onto the source span covering "bold" (the
    // exact markup-boundary landing — start may sit just before the opening `**`
    // — is renderedOffsetToSource's existing semantics; the contract here is that
    // the span is non-empty and contains the selected word).
    expect(anchor!.start).toBeLessThan(anchor!.end);
    expect(source.slice(anchor!.start, anchor!.end)).toContain('bold');
  });

  it('returns null when the selection lives OUTSIDE this body', () => {
    tagAc(AC_RELIABLE);
    const body = bodyWith('<p>Inside text</p>');
    const outside = document.createElement('p');
    outside.textContent = 'Outside text';
    document.body.appendChild(outside);
    const tn = outside.firstChild!;
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, 7);

    expect(computeAnchorFromRange(range, body, 'Inside text')).toBeNull();
  });

  it('returns null for a collapsed (empty) selection', () => {
    tagAc(AC_RELIABLE);
    const source = 'The quick brown fox';
    const body = bodyWith(`<p>${source}</p>`);
    const tn = body.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(tn, 4);
    range.setEnd(tn, 4);

    expect(computeAnchorFromRange(range, body, source)).toBeNull();
  });
});
