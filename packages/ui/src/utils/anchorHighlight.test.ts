import { describe, it, expect, afterEach } from 'vitest';
import { buildAnchorRange } from './anchorHighlight';
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-1: the anchored span is reproduced as a highlight (a phrase
// highlights just the phrase, a multi-paragraph selection highlights the block).
const AC_ANCHOR = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1';
// spec-100 ac-12: clicking a gutter comment highlights its anchored span.
const AC_GUTTER = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-12';

// Render the same shape withRenderedMarkers + the markdown `code` override
// produce: a zero-width start sentinel `#marker-c-N-start` and an end bubble
// `#marker-c-N` (data-marker-seq, so the walker skips its text).
function mount(html: string): void {
  document.body.innerHTML = html;
}
afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildAnchorRange', () => {
  it('RANGE: highlights exactly the span between the start sentinel and the end bubble', () => {
    tagAc(AC_ANCHOR);
    tagAc(AC_GUTTER);
    mount(
      '<p>know <span id="marker-c-3-start" data-marker-start="3"></span>Spec-by-Spec' +
        '<span id="marker-c-3" data-marker-seq="3">B</span> for what changed</p>',
    );
    const range = buildAnchorRange(
      document.getElementById('marker-c-3')!,
      document.getElementById('marker-c-3-start'),
    );
    expect(range).not.toBeNull();
    // The highlight is precisely the selection, not the surrounding sentence.
    expect(range!.toString()).toBe('Spec-by-Spec');
  });

  it('RANGE: spans across paragraphs (a multi-block selection highlights the block)', () => {
    tagAc(AC_ANCHOR);
    mount(
      '<div><p>alpha <span id="marker-c-4-start"></span>beta</p>' +
        '<p>gamma<span id="marker-c-4" data-marker-seq="4">B</span> delta</p></div>',
    );
    const range = buildAnchorRange(
      document.getElementById('marker-c-4')!,
      document.getElementById('marker-c-4-start'),
    );
    expect(range).not.toBeNull();
    // Range text spans both paragraphs' selected portion (DOM toString drops the
    // inter-element boundary): "beta" ... "gamma".
    expect(range!.toString()).toBe('betagamma');
  });

  // The real bubble is an SVG (no text), so a sentence Range that encloses it
  // adds no characters; the fixtures use an SVG-only bubble to match.
  it('POINT / legacy (no start sentinel): falls back to the marker\'s sentence', () => {
    tagAc(AC_GUTTER);
    mount('<p>First one. Hello world<span id="marker-c-1" data-marker-seq="1"><svg></svg></span>. Bye.</p>');
    const range = buildAnchorRange(document.getElementById('marker-c-1')!, null);
    expect(range).not.toBeNull();
    // The sentence containing the marker, derived from the marker's DOM position.
    expect(range!.toString()).toBe('Hello world.');
  });

  it('POINT: highlights a sentence even when it contains inline formatting', () => {
    tagAc(AC_GUTTER);
    // <strong> splits the sentence across element boundaries; the walk is immune.
    mount('<p>Intro. The <strong>bold</strong> claim<span id="marker-c-2" data-marker-seq="2"><svg></svg></span>. End.</p>');
    const range = buildAnchorRange(document.getElementById('marker-c-2')!, null);
    expect(range!.toString()).toBe('The bold claim.');
  });

  it('returns null when the marker has no surrounding text to anchor to', () => {
    const detached = document.createElement('span'); // not attached to any block
    expect(buildAnchorRange(detached, null)).toBeNull();
  });
});
