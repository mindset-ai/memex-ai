import { describe, it, expect } from "vitest";
import { serializeSectionToExportForm, type ExportComment } from "./export-form.js";

// spec-100 §4: the export / LLM form. A deterministic serialization of the
// storage form (`[^c-N]` glyphs + a side table) in which every marker is
// replaced by an inline HTML-comment-delimited block-quote carrying the full
// thread. HTML comments are invisible in every renderer; the block-quote is
// human-readable. The same form is fed to the in-Memex agent for action-button
// operations, so the agent sees comments in situ rather than via a side table.

const baseDate = new Date("2026-05-27T10:00:00Z");

function comment(overrides: Partial<ExportComment> = {}): ExportComment {
  return {
    seq: 123,
    authorName: "Wic",
    commentType: "issue",
    resolvedAt: null,
    createdAt: baseDate,
    anchorSnippet: "The proxy emits llm_call events",
    content: "This is wrong; llm_call doesn't fire for streaming chunks.",
    ...overrides,
  };
}

describe("serializeSectionToExportForm — anchored markers", () => {
  it("expands a marker into an HTML-comment-delimited block-quote in situ", () => {
    const content = "The proxy emits llm_call events[^c-123] when an outbound call is made.";
    const out = serializeSectionToExportForm(content, [comment()]);

    expect(out).toBe(
      "The proxy emits llm_call events<!-- comment-start c-123 -->\n" +
        '> **Wic** (issue, open, 2026-05-27, anchored to: "The proxy emits llm_call events")\n' +
        "> This is wrong; llm_call doesn't fire for streaming chunks.\n" +
        "<!-- comment-end c-123 --> when an outbound call is made.",
    );
  });

  it("renders resolved status from resolvedAt", () => {
    const content = "Claim[^c-123] here.";
    const out = serializeSectionToExportForm(content, [
      comment({ resolvedAt: new Date("2026-05-28T09:00:00Z") }),
    ]);
    expect(out).toContain("(issue, resolved, 2026-05-27");
  });

  it("quotes multi-line comment bodies with a leading > on every line", () => {
    const content = "Claim[^c-123] here.";
    const out = serializeSectionToExportForm(content, [
      comment({ content: "Line one.\nLine two." }),
    ]);
    expect(out).toContain("> Line one.\n> Line two.");
  });

  it("expands multiple distinct markers independently", () => {
    const content = "Alpha[^c-1] and beta[^c-2].";
    const out = serializeSectionToExportForm(content, [
      comment({ seq: 1, authorName: "A", content: "first" }),
      comment({ seq: 2, authorName: "B", content: "second" }),
    ]);
    expect(out).toContain("<!-- comment-start c-1 -->");
    expect(out).toContain("<!-- comment-start c-2 -->");
    expect(out).toContain("> first");
    expect(out).toContain("> second");
  });

  it("omits the anchor clause when the comment has no snippet", () => {
    const content = "Claim[^c-123] here.";
    const out = serializeSectionToExportForm(content, [comment({ anchorSnippet: null })]);
    expect(out).toContain("(issue, open, 2026-05-27)");
    expect(out).not.toContain("anchored to:");
  });
});

describe("serializeSectionToExportForm — edge cases", () => {
  it("drops a dangling marker whose comment no longer exists (no broken footnote)", () => {
    const content = "Orphaned glyph[^c-999] in source.";
    const out = serializeSectionToExportForm(content, []);
    expect(out).toBe("Orphaned glyph in source.");
  });

  it("appends floating (unanchored) comments after the content, ordered by seq", () => {
    const content = "Body with no markers.";
    const out = serializeSectionToExportForm(content, [
      comment({ seq: 5, anchorSnippet: null, content: "second floating" }),
      comment({ seq: 2, anchorSnippet: null, content: "first floating" }),
    ]);
    // Content first, untouched.
    expect(out.startsWith("Body with no markers.")).toBe(true);
    // Floating comments appended in seq order.
    expect(out.indexOf("c-2")).toBeLessThan(out.indexOf("c-5"));
    expect(out).toContain("> first floating");
    expect(out).toContain("> second floating");
  });

  it("is a no-op on content with no markers and no comments", () => {
    expect(serializeSectionToExportForm("plain text", [])).toBe("plain text");
  });
});
