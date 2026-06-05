import { describe, it, expect, afterEach } from 'vitest';
import { renderedOffsetToSource, resolveRenderedOffset } from './anchorOffset';
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-1: anchor by POSITION, not by fingerprinting text — so a selection
// resolves to exactly where the user selected (not the first matching word), and
// works across inline formatting.
const AC_ANCHOR = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1';

// Helper: rendered text is what the user sees (markdown stripped). The offset is
// where their selection ends in that rendered text.
describe('renderedOffsetToSource', () => {
  it('maps a plain-prose offset 1:1', () => {
    tagAc(AC_ANCHOR);
    const src = 'The proxy emits events.';
    const rendered = 'The proxy emits events.';
    // end of "The proxy emits events"
    expect(renderedOffsetToSource(src, rendered, 22)).toBe(22);
  });

  it('skips ** when the selection ends after a bolded word', () => {
    tagAc(AC_ANCHOR);
    const src = 'know **whether** something';
    const rendered = 'know whether something';
    // rendered offset at end of "whether" (5 + 7 = 12)
    const off = renderedOffsetToSource(src, rendered, 'know whether'.length);
    expect(src.slice(0, off)).toBe('know **whether'); // right after the word, before closing **
  });

  it('skips inline code backticks', () => {
    const src = 'flows through `mutate()` today';
    const rendered = 'flows through mutate() today';
    const off = renderedOffsetToSource(src, rendered, 'flows through mutate()'.length);
    expect(src.slice(0, off)).toBe('flows through `mutate()');
  });

  it('does NOT collide on a ubiquitous repeated word — position decides, not text', () => {
    tagAc(AC_ANCHOR);
    // "is" appears 3 times; selecting up to the THIRD "is" must map there, not the first.
    const src = 'X is A. Y is B. Z is C.';
    const rendered = 'X is A. Y is B. Z is C.';
    const renderedOffset = src.lastIndexOf('is') + 2; // end of the 3rd "is"
    const off = renderedOffsetToSource(src, rendered, renderedOffset);
    expect(off).toBe(renderedOffset);
    // and it's the third one, not the first
    expect(src.slice(0, off).match(/is/g)?.length).toBe(3);
  });

  it('preserves snake_case (underscores are literal)', () => {
    const src = 'emits llm_call events';
    const rendered = 'emits llm_call events';
    const off = renderedOffsetToSource(src, rendered, 'emits llm_call'.length);
    expect(src.slice(0, off)).toBe('emits llm_call');
  });

  it('treats a paragraph break (source \\n\\n) as the whitespace the render collapses', () => {
    const src = 'First para.\n\nSecond para.';
    const rendered = 'First para.Second para.'; // adjacent text nodes, no separator
    const off = renderedOffsetToSource(src, rendered, 'First para.Second'.length);
    expect(src.slice(0, off)).toBe('First para.\n\nSecond');
  });

  it('clamps an out-of-range rendered offset', () => {
    expect(renderedOffsetToSource('abc', 'abc', 99)).toBe(3);
  });
});

// resolveRenderedOffset turns a DOM Range boundary into a rendered offset (the
// first half of mapping a selection to a source offset). ac-1: a selection
// anchors correctly regardless of which DOM node its boundary lands on.
describe('resolveRenderedOffset', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('maps a text-node boundary directly (start + domOffset)', () => {
    tagAc(AC_ANCHOR);
    document.body.innerHTML = '<p>hello world</p>';
    const textNode = document.querySelector('p')!.firstChild!;
    const starts = [{ node: textNode, start: 0 }];
    expect(resolveRenderedOffset(textNode, 6, starts, 11)).toBe(6);
  });

  it('returns -1 when the boundary text node was rejected from the walk', () => {
    document.body.innerHTML = '<p>visible</p><p>skipped</p>';
    const visible = document.querySelectorAll('p')[0].firstChild!;
    const skipped = document.querySelectorAll('p')[1].firstChild!;
    const starts = [{ node: visible, start: 0 }];
    expect(resolveRenderedOffset(skipped, 2, starts, 7)).toBe(-1);
  });

  it('resolves an element-node boundary to the first text node at/after it', () => {
    tagAc(AC_ANCHOR);
    // <p><b>bold</b> tail</p>: a selection starting on the <b> element edge.
    document.body.innerHTML = '<p><b>bold</b> tail</p>';
    const p = document.querySelector('p')!;
    const boldText = p.querySelector('b')!.firstChild!;
    const tailText = p.childNodes[1]; // " tail"
    const starts = [
      { node: boldText, start: 0 },
      { node: tailText, start: 4 },
    ];
    const totalLen = 9; // "bold tail"
    // Boundary before child 0 (the <b>): resolves into the bold run at 0.
    expect(resolveRenderedOffset(p, 0, starts, totalLen)).toBe(0);
    // Boundary before child 1 (the tail text node): resolves at 4.
    expect(resolveRenderedOffset(p, 1, starts, totalLen)).toBe(4);
  });

  it('returns the total length when the boundary is past the last child', () => {
    document.body.innerHTML = '<p><b>bold</b> tail</p>';
    const p = document.querySelector('p')!;
    const starts = [
      { node: p.querySelector('b')!.firstChild!, start: 0 },
      { node: p.childNodes[1], start: 4 },
    ];
    expect(resolveRenderedOffset(p, 2, starts, 9)).toBe(9);
  });
});
