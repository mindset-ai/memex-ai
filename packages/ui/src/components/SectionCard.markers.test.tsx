import { describe, it, expect } from 'vitest';
import { withRenderedMarkers } from './SectionCard';
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-1: anchored comments show in situ — the `[^c-N]` source marker
// renders as a visible badge in the section body (rather than leaking the raw
// footnote glyph or vanishing).
const AC_ANCHOR = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1';
// spec-100 ac-9/ac-12: the marker layer is a slave to the gutter filter — only
// visible (open) comments display their marker.
const AC_FILTER = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-9';
// dec-6: marker layer is a slave to the gutter filter (resolve hides, not deletes).
const AC_MARKER_FILTER = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-15';

describe('withRenderedMarkers', () => {
  it('turns a visible comment\'s source marker into a badge', () => {
    tagAc(AC_ANCHOR);
    expect(withRenderedMarkers('events[^c-2] when', new Set([2]))).toBe('events`📍c-2` when');
  });

  it('renders only markers for visible comments, strips the rest', () => {
    tagAc(AC_FILTER);
    tagAc(AC_MARKER_FILTER);
    // c-1 visible (open) → badge; c-22 not visible (resolved/filtered) → stripped.
    expect(withRenderedMarkers('a[^c-1] b[^c-22] c', new Set([1]))).toBe('a`📍c-1` b c');
  });

  it('strips all markers when none are visible (e.g. all resolved)', () => {
    tagAc(AC_FILTER);
    expect(withRenderedMarkers('a[^c-1] b[^c-2] c', new Set())).toBe('a b c');
  });

  it('is a no-op on prose with no markers', () => {
    expect(withRenderedMarkers('plain prose, no anchors', new Set([1, 2]))).toBe('plain prose, no anchors');
  });

  // dec-1 (amended): a RANGE renders a zero-width start sentinel (`📍c-Ns`) and a
  // bubble end sentinel (`📍c-N`); both are stripped together when not visible.
  it('renders a range as a start sentinel + end bubble when visible', () => {
    tagAc(AC_ANCHOR);
    expect(withRenderedMarkers('know [^c-3s]Spec-by-Spec[^c-3e] for', new Set([3]))).toBe(
      'know `📍c-3s`Spec-by-Spec`📍c-3` for',
    );
  });

  it('strips BOTH sentinels of a non-visible range', () => {
    tagAc(AC_MARKER_FILTER);
    expect(withRenderedMarkers('know [^c-3s]Spec-by-Spec[^c-3e] for', new Set())).toBe(
      'know Spec-by-Spec for',
    );
  });

  it('still renders a legacy point marker as a bubble (back-compat)', () => {
    expect(withRenderedMarkers('events[^c-2] when', new Set([2]))).toBe('events`📍c-2` when');
  });
});
