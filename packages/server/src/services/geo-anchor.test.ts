import { describe, it, expect } from "vitest";
import {
  markerGlyph,
  markerStartGlyph,
  markerEndGlyph,
  insertMarkerAt,
  insertRangeMarkers,
  captureSnippet,
  captureRangeSnippet,
  hasMarker,
  hasAnchorMarker,
  stripMarkers,
  stripMarkersForSeq,
  extractMarkerSeqs,
  findDestroyedMarkers,
  assertMarkersPreserved,
  findDriftedMarkers,
  snapToWordBoundary,
  snapToWordStart,
} from "./geo-anchor.js";
import { ValidationError } from "../types/errors.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 dec-1: the marker is a single footnote-style glyph that IS a real
// character of the markdown source, so it rides along with the text under
// edits with no offset bookkeeping. These are the pure string primitives the
// anchored-create + orphan-detection flows are built on.
const AC_DEC1_ANCHOR = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-7";
// Scope ac-1: anchored comment whose anchor survives subsequent edits.
const AC_SCOPE_ANCHOR = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1";

describe("markerGlyph", () => {
  it("renders the footnote-style glyph from a seq", () => {
    expect(markerGlyph(123)).toBe("[^c-123]");
  });
});

describe("insertMarkerAt", () => {
  it("inserts the glyph at the given offset", () => {
    const content = "The proxy emits llm_call events when a call is made.";
    const offset = "The proxy emits llm_call events".length;
    expect(insertMarkerAt(content, offset, "[^c-5]")).toBe(
      "The proxy emits llm_call events[^c-5] when a call is made.",
    );
  });

  it("clamps a negative offset to the start", () => {
    expect(insertMarkerAt("hello", -10, "[^c-1]")).toBe("[^c-1]hello");
  });

  it("clamps an over-long offset to the end", () => {
    expect(insertMarkerAt("hello", 999, "[^c-1]")).toBe("hello[^c-1]");
  });
});

describe("marker rides along with the text (dec-1 core property)", () => {
  it("survives a paragraph being cut and pasted elsewhere", () => {
    tagAc(AC_DEC1_ANCHOR);
    tagAc(AC_SCOPE_ANCHOR);
    // The marker is a real character of the source, so moving the paragraph
    // that contains it moves the marker too — no offset bookkeeping.
    const para = `Anchored claim[^c-9] lives here.`;
    const before = `Intro paragraph.\n\n${para}\n\nClosing paragraph.`;
    // Simulate a reorder: move the anchored paragraph to the top.
    const after = `${para}\n\nIntro paragraph.\n\nClosing paragraph.`;

    expect(hasMarker(before, "[^c-9]")).toBe(true);
    expect(hasMarker(after, "[^c-9]")).toBe(true);
    // The marker stays inside its own sentence regardless of position.
    expect(after).toContain("Anchored claim[^c-9] lives here.");
  });

  it("survives edits to surrounding text (marker position unchanged relative to its sentence)", () => {
    tagAc(AC_DEC1_ANCHOR);
    tagAc(AC_SCOPE_ANCHOR);
    const edited = `A rewritten, longer intro sentence. Anchored claim[^c-9] lives here.`;
    expect(hasMarker(edited, "[^c-9]")).toBe(true);
    expect(edited).toContain("Anchored claim[^c-9] lives here.");
  });
});

describe("hasMarker (orphan detection primitive)", () => {
  it("is true when the glyph is present", () => {
    expect(hasMarker("a sentence[^c-7] continues", "[^c-7]")).toBe(true);
  });

  it("is false once the glyph has been edited out", () => {
    expect(hasMarker("a sentence continues", "[^c-7]")).toBe(false);
  });

  it("does not match a different comment's glyph (no prefix collision)", () => {
    // c-7 must not be considered present just because c-70 is.
    expect(hasMarker("text[^c-70] here", "[^c-7]")).toBe(false);
  });
});

describe("captureSnippet", () => {
  it("captures the sentence containing the offset", () => {
    tagAc(AC_DEC1_ANCHOR);
    const content =
      "First sentence here. The proxy emits llm_call events when an outbound call is made. Third sentence.";
    const offset = content.indexOf("llm_call");
    expect(captureSnippet(content, offset)).toBe(
      "The proxy emits llm_call events when an outbound call is made.",
    );
  });

  it("handles an offset in the first sentence (no leading boundary)", () => {
    const content = "The proxy emits events. Then more.";
    expect(captureSnippet(content, 5)).toBe("The proxy emits events.");
  });

  it("treats a newline as a sentence boundary", () => {
    const content = "Heading line\nThe body paragraph starts here and runs on.";
    const offset = content.indexOf("body");
    expect(captureSnippet(content, offset)).toBe(
      "The body paragraph starts here and runs on.",
    );
  });

  it("caps an over-long run with no boundary at maxLen", () => {
    const content = "x".repeat(500);
    const snippet = captureSnippet(content, 250, 120);
    expect(snippet.length).toBeLessThanOrEqual(120);
  });

  it("never returns empty for non-empty content (the 400-on-save guard)", () => {
    tagAc(AC_DEC1_ANCHOR);
    // Offset in a whitespace/marker-only neighbourhood — sentence detection
    // yields nothing, so it must fall back to a surrounding window.
    const content = "Real prose here.\n\n   \n\nMore prose.";
    const offsetInBlank = content.indexOf("   ") + 1;
    expect(captureSnippet(content, offsetInBlank).length).toBeGreaterThan(0);
    // Offset right at the end of content.
    expect(captureSnippet(content, content.length).length).toBeGreaterThan(0);
  });

  it("strips a neighbouring comment's marker out of the snapshot", () => {
    const content = "The proxy emits llm_call events[^c-5] when a call is made.";
    const offset = content.indexOf("llm_call");
    expect(captureSnippet(content, offset)).toBe(
      "The proxy emits llm_call events when a call is made.",
    );
  });
});

describe("snapToWordBoundary (marker never lands mid-word)", () => {
  it("advances a mid-word offset to the end of the word", () => {
    tagAc(AC_DEC1_ANCHOR);
    const content = "pollute the active view";
    const midActive = content.indexOf("active") + 3; // inside "act|ive"
    expect(snapToWordBoundary(content, midActive)).toBe(content.indexOf("active") + "active".length);
  });

  it("leaves an offset already at a boundary unchanged", () => {
    const content = "end of word. Next";
    const afterWord = "end of word".length; // right before "."
    expect(snapToWordBoundary(content, afterWord)).toBe(afterWord);
    expect(snapToWordBoundary(content, 0)).toBe(0);
  });

  it("clamps out-of-range offsets", () => {
    expect(snapToWordBoundary("abc", 99)).toBe(3);
    expect(snapToWordBoundary("abc", -5)).toBe(0);
  });
});

describe("stripMarkers", () => {
  it("removes all marker glyphs", () => {
    expect(stripMarkers("a[^c-1] b[^c-22] c")).toBe("a b c");
  });

  it("leaves text without markers untouched", () => {
    expect(stripMarkers("plain text")).toBe("plain text");
  });
});

describe("extractMarkerSeqs", () => {
  it("returns the seqs of every marker present, de-duplicated and sorted", () => {
    expect(extractMarkerSeqs("a[^c-3] b[^c-1] c[^c-3]")).toEqual([1, 3]);
  });

  it("returns empty for marker-free content", () => {
    expect(extractMarkerSeqs("no markers")).toEqual([]);
  });
});

describe("findDestroyedMarkers (the spec §3 presence gate)", () => {
  it("reports a marker present before an edit but missing after", () => {
    tagAc(AC_DEC1_ANCHOR);
    const before = "Keep[^c-1] this and[^c-2] that.";
    const after = "Keep[^c-1] this only."; // c-2 was destroyed
    expect(findDestroyedMarkers(before, after)).toEqual([2]);
  });

  it("reports nothing when every marker survives", () => {
    const before = "Keep[^c-1] this and[^c-2] that.";
    const after = "Totally reworded[^c-1] sentence, still[^c-2] here.";
    expect(findDestroyedMarkers(before, after)).toEqual([]);
  });

  it("does not treat a newly-added marker as a problem", () => {
    const before = "Keep[^c-1] this.";
    const after = "Keep[^c-1] this and add[^c-9] more.";
    expect(findDestroyedMarkers(before, after)).toEqual([]);
  });
});

describe("assertMarkersPreserved (fail loudly per spec §3)", () => {
  it("throws a ValidationError naming the destroyed markers", () => {
    const before = "a[^c-7] b[^c-8]";
    const after = "a[^c-7]"; // c-8 destroyed
    expect(() => assertMarkersPreserved(before, after)).toThrow(ValidationError);
    expect(() => assertMarkersPreserved(before, after)).toThrow(/c-8/);
  });

  it("does not throw when all markers are preserved", () => {
    expect(() => assertMarkersPreserved("a[^c-7]", "reworded a[^c-7] still")).not.toThrow();
  });
});

describe("findDriftedMarkers (position drift — beyond mere presence)", () => {
  it("flags a marker whose anchored sentence changed even though it survived", () => {
    const before = "The proxy emits llm_call events[^c-1] here. Other sentence.";
    // c-1 survived but is now attached to a completely different sentence.
    const after = "Other sentence. A totally different claim[^c-1] now.";
    expect(findDriftedMarkers(before, after)).toEqual([1]);
  });

  it("does not flag a marker whose surrounding sentence is unchanged", () => {
    const before = "Intro. The proxy emits llm_call events[^c-1] here.";
    const after = "A rewritten intro paragraph. The proxy emits llm_call events[^c-1] here.";
    expect(findDriftedMarkers(before, after)).toEqual([]);
  });

  it("ignores destroyed markers (those are the presence gate's job)", () => {
    const before = "claim[^c-1] one.";
    const after = "claim one."; // destroyed, not drifted
    expect(findDriftedMarkers(before, after)).toEqual([]);
  });
});

// ── dec-1 (amended): RANGE anchors — a start + end sentinel bracket the
// selected region so the highlight reproduces the selection, not a sentence.
const AC_RANGE = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-1";

describe("range sentinels", () => {
  it("produces distinct start/end glyphs that don't collide with the legacy point", () => {
    expect(markerStartGlyph(5)).toBe("[^c-5s]");
    expect(markerEndGlyph(5)).toBe("[^c-5e]");
    expect(markerGlyph(5)).toBe("[^c-5]");
  });

  it("insertRangeMarkers brackets exactly the selected span", () => {
    tagAc(AC_RANGE);
    const src = "know whether Spec-by-Spec for what changed";
    const start = src.indexOf("Spec-by-Spec");
    const end = start + "Spec-by-Spec".length;
    const out = insertRangeMarkers(src, start, end, 3);
    expect(out).toBe("know whether [^c-3s]Spec-by-Spec[^c-3e] for what changed");
    // The text BETWEEN the sentinels is precisely the selection.
    const between = out.slice(out.indexOf("[^c-3s]") + 7, out.indexOf("[^c-3e]"));
    expect(between).toBe("Spec-by-Spec");
  });

  it("rides along when text is inserted BEFORE the range (both sentinels shift)", () => {
    tagAc(AC_RANGE);
    const ranged = insertRangeMarkers("api design here", 4, 10, 1); // "design"
    const toc = "# Table of contents\n\n";
    const after = toc + ranged;
    // Both sentinels are still present and still bracket "design".
    expect(hasAnchorMarker(after, 1)).toBe(true);
    const between = after.slice(after.indexOf("[^c-1s]") + 7, after.indexOf("[^c-1e]"));
    expect(between).toBe("design");
  });

  it("grows to include text inserted BETWEEN the sentinels", () => {
    const ranged = insertRangeMarkers("the region here", 4, 10, 1); // "region"
    // Simulate an edit that inserts inside the bracketed span.
    const edited = ranged.replace("region", "whole region");
    const between = edited.slice(edited.indexOf("[^c-1s]") + 7, edited.indexOf("[^c-1e]"));
    expect(between).toBe("whole region");
  });
});

describe("snapToWordStart (range start never splits a word)", () => {
  it("treats a hyphen as a word boundary and does not cross it", () => {
    const src = "the Spec-by-Spec hunt";
    const atBy = src.indexOf("by"); // sits just after a hyphen (a boundary)
    expect(snapToWordStart(src, atBy)).toBe(atBy);
  });

  it("retreats into a plain word", () => {
    const src = "alpha bravo charlie";
    const mid = src.indexOf("bravo") + 2; // inside "bravo"
    expect(snapToWordStart(src, mid)).toBe(src.indexOf("bravo"));
  });

  it("leaves an offset already at a boundary untouched", () => {
    const src = "alpha bravo";
    expect(snapToWordStart(src, 6)).toBe(6); // start of "bravo"
    expect(snapToWordStart(src, 0)).toBe(0);
  });
});

describe("captureRangeSnippet (snapshot = the selected text)", () => {
  it("captures exactly the selection, stripped + collapsed", () => {
    tagAc(AC_RANGE);
    const src = "know whether Spec-by-Spec for what changed";
    const start = src.indexOf("Spec-by-Spec");
    const end = start + "Spec-by-Spec".length;
    expect(captureRangeSnippet(src, start, end)).toBe("Spec-by-Spec");
  });

  it("strips any neighbouring markers inside the range", () => {
    const src = "alpha [^c-9e] bravo charlie";
    expect(captureRangeSnippet(src, 0, src.length)).toBe("alpha bravo charlie");
  });

  it("falls back to the end sentence when the slice is blank", () => {
    const src = "   . The real sentence here.";
    // A whitespace-only selection at the front yields a non-empty fallback.
    expect(captureRangeSnippet(src, 0, 3)).not.toBe("");
  });
});

describe("3-form awareness: strip / extract / orphan across start+end+legacy", () => {
  it("stripMarkers removes start, end, and legacy glyphs alike", () => {
    expect(stripMarkers("a[^c-1s]b[^c-1e]c[^c-2]d")).toBe("abcd");
  });

  it("stripMarkersForSeq removes only the named comment's sentinels", () => {
    const src = "x[^c-1s]y[^c-1e]z[^c-2e]w";
    expect(stripMarkersForSeq(src, 1)).toBe("xyz[^c-2e]w");
  });

  it("extractMarkerSeqs dedupes a range's two sentinels to one seq", () => {
    expect(extractMarkerSeqs("a[^c-3s]b[^c-3e]c[^c-7e]d")).toEqual([3, 7]);
  });

  it("hasAnchorMarker is true on the end sentinel OR the legacy point", () => {
    expect(hasAnchorMarker("a[^c-3e]b", 3)).toBe(true);
    expect(hasAnchorMarker("a[^c-3]b", 3)).toBe(true); // legacy
    expect(hasAnchorMarker("a[^c-3s]b", 3)).toBe(false); // start alone is not enough
    expect(hasAnchorMarker("a[^c-30e]b", 3)).toBe(false); // no prefix collision
  });

  it("the presence gate treats a range as one survivor (end gone = destroyed)", () => {
    const before = "p[^c-1s]q[^c-1e]r[^c-2e]s";
    // An edit that drops c-1's end sentinel destroys c-1; c-2 survives.
    const after = "p q r[^c-2e]s";
    expect(findDestroyedMarkers(before, after)).toEqual([1]);
  });
});
