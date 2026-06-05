import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { markdownToMrkdwn } from "./slack-markdown.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-71";
const AC_1 = `${SPEC}/acs/ac-1`;
const AC_2 = `${SPEC}/acs/ac-2`;
const AC_3 = `${SPEC}/acs/ac-3`;
const AC_4 = `${SPEC}/acs/ac-4`;
const AC_5 = `${SPEC}/acs/ac-5`;

describe("markdownToMrkdwn", () => {
  describe("bold", () => {
    it("converts **bold** to *bold*", () => {
      tagAc(AC_1);
      expect(markdownToMrkdwn("**bold**")).toBe("*bold*");
    });

    it("converts bold mid-sentence", () => {
      tagAc(AC_1);
      expect(markdownToMrkdwn("Hello **world** there")).toBe("Hello *world* there");
    });

    it("converts multiple bold spans", () => {
      tagAc(AC_1);
      expect(markdownToMrkdwn("**a** and **b**")).toBe("*a* and *b*");
    });
  });

  describe("italic", () => {
    it("converts *italic* to _italic_", () => {
      tagAc(AC_2);
      expect(markdownToMrkdwn("*italic*")).toBe("_italic_");
    });

    it("leaves _italic_ unchanged (already mrkdwn)", () => {
      tagAc(AC_2);
      expect(markdownToMrkdwn("_italic_")).toBe("_italic_");
    });

    it("does not convert bold ** as italic", () => {
      tagAc(AC_2);
      expect(markdownToMrkdwn("**bold**")).toBe("*bold*");
    });

    it("converts bold and italic independently", () => {
      tagAc(AC_1);
      tagAc(AC_2);
      expect(markdownToMrkdwn("**bold** and *italic*")).toBe("*bold* and _italic_");
    });
  });

  describe("inline code", () => {
    it("preserves inline code spans unchanged", () => {
      tagAc(AC_3);
      expect(markdownToMrkdwn("`code`")).toBe("`code`");
    });

    it("does not convert markdown inside code spans", () => {
      tagAc(AC_3);
      expect(markdownToMrkdwn("`**not bold**`")).toBe("`**not bold**`");
    });

    it("preserves code spans alongside other conversions", () => {
      tagAc(AC_3);
      expect(markdownToMrkdwn("**bold** and `code`")).toBe("*bold* and `code`");
    });
  });

  describe("links", () => {
    it("converts [text](url) to <url|text>", () => {
      tagAc(AC_4);
      expect(markdownToMrkdwn("[click here](https://example.com)")).toBe("<https://example.com|click here>");
    });

    it("converts links mid-sentence", () => {
      tagAc(AC_4);
      expect(markdownToMrkdwn("See [docs](https://memex.ai) for details")).toBe(
        "See <https://memex.ai|docs> for details",
      );
    });
  });

  describe("headings", () => {
    it("converts # Heading to *Heading*", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("# My Heading")).toBe("*My Heading*");
    });

    it("converts ## and deeper headings to *Heading*", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("## Sub\n### Deep")).toBe("*Sub*\n*Deep*");
    });
  });

  describe("bullet lists", () => {
    it("passes bullet lists through unchanged", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("- item one\n- item two")).toBe("- item one\n- item two");
    });
  });

  describe("unrecognised constructs", () => {
    it("strips ~~strikethrough~~ markers", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("~~strike~~")).toBe("strike");
    });

    it("does not leak raw markdown syntax for stripped constructs", () => {
      tagAc(AC_5);
      const result = markdownToMrkdwn("~~strike~~");
      expect(result).not.toContain("~~");
    });
  });

  describe("plain text", () => {
    it("passes plain text through unchanged", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("Hello world")).toBe("Hello world");
    });

    it("passes empty string through unchanged", () => {
      tagAc(AC_5);
      expect(markdownToMrkdwn("")).toBe("");
    });
  });
});
