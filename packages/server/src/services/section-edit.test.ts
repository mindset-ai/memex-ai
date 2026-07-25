// spec-503: the pure literal-edit engine's truth table. The engine is the
// no-surprises core of edit_section — literal matching only, no regex and no
// String.replace $-pattern semantics may leak into replacements.
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { applyLiteralEdit } from "./section-edit.js";

const AC_LITERAL = "mindset-prod/memex-building-itself/specs/spec-503/acs/ac-7";
const AC_SINGLE_PAIR = "mindset-prod/memex-building-itself/specs/spec-503/acs/ac-12";

describe("applyLiteralEdit — hit counting", () => {
  it("zero hits → kind 'zero', content untouched", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("alpha beta gamma", "delta", "epsilon", false);
    expect(result).toEqual({ kind: "zero" });
  });

  it("one hit → replaced, count 1", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("alpha beta gamma", "beta", "BETA", false);
    expect(result).toEqual({ kind: "ok", content: "alpha BETA gamma", count: 1 });
  });

  it("many hits with replaceAll false → kind 'ambiguous' with the exact count", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("x y x y x", "x", "z", false);
    expect(result).toEqual({ kind: "ambiguous", count: 3 });
  });

  it("many hits with replaceAll true → all replaced, count reported", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("x y x y x", "x", "z", true);
    expect(result).toEqual({ kind: "ok", content: "z y z y z", count: 3 });
  });

  it("replaceAll true with a single hit still succeeds with count 1", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("alpha beta", "beta", "gamma", true);
    expect(result).toEqual({ kind: "ok", content: "alpha gamma", count: 1 });
  });

  it("counts non-overlapping occurrences only", () => {
    tagAc(AC_LITERAL);
    // "aaaa" contains two non-overlapping "aa", not three.
    const result = applyLiteralEdit("aaaa", "aa", "b", true);
    expect(result).toEqual({ kind: "ok", content: "bb", count: 2 });
  });
});

describe("applyLiteralEdit — literal semantics (no regex, no $-patterns)", () => {
  it("treats regex metacharacters in oldText as plain text", () => {
    tagAc(AC_LITERAL);
    const content = "value = arr[i].*x + (y)?";
    const result = applyLiteralEdit(content, "arr[i].*x + (y)?", "next", false);
    expect(result).toEqual({ kind: "ok", content: "value = next", count: 1 });
  });

  it("a metacharacter oldText does not match via regex interpretation", () => {
    tagAc(AC_LITERAL);
    // As a regex ".*" would match anything; literally it must match nothing here.
    const result = applyLiteralEdit("plain words only", ".*", "x", false);
    expect(result).toEqual({ kind: "zero" });
  });

  it("leaves $-patterns in newText verbatim (no substitution semantics)", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("keep the token here", "token", "$& $1 $' literal", false);
    expect(result).toEqual({
      kind: "ok",
      content: "keep the $& $1 $' literal here",
      count: 1,
    });
  });

  it("is case-sensitive", () => {
    tagAc(AC_LITERAL);
    expect(applyLiteralEdit("Alpha alpha", "ALPHA", "x", false)).toEqual({ kind: "zero" });
  });

  it("is whitespace-sensitive", () => {
    tagAc(AC_LITERAL);
    expect(applyLiteralEdit("a  b", "a b", "x", false)).toEqual({ kind: "zero" });
  });

  it("matches multi-line oldText across newlines exactly", () => {
    tagAc(AC_LITERAL);
    const content = "line one\nline two\nline three";
    const result = applyLiteralEdit(content, "line two\nline", "row 2\nrow", false);
    expect(result).toEqual({ kind: "ok", content: "line one\nrow 2\nrow three", count: 1 });
  });

  it("handles unicode (emoji, combining marks) as plain code units", () => {
    tagAc(AC_LITERAL);
    const result = applyLiteralEdit("café ☕ café", "café", "tea", true);
    expect(result).toEqual({ kind: "ok", content: "tea ☕ tea", count: 2 });
  });

  it("matches inside markdown syntax verbatim (backticks, fences, list markers)", () => {
    tagAc(AC_LITERAL);
    const content = "- item `code`\n```ts\nconst a = 1;\n```";
    const result = applyLiteralEdit(content, "`code`", "`snippet`", false);
    expect(result).toEqual({
      kind: "ok",
      content: "- item `snippet`\n```ts\nconst a = 1;\n```",
      count: 1,
    });
  });
});

describe("applyLiteralEdit — input guards (one valid pair per call)", () => {
  it("empty oldText → kind 'invalid' (whole-body replacement is update_section's job)", () => {
    tagAc(AC_SINGLE_PAIR);
    expect(applyLiteralEdit("anything", "", "x", false)).toEqual({
      kind: "invalid",
      reason: "empty-old",
    });
  });

  it("oldText identical to newText → kind 'invalid' (no-op edit)", () => {
    tagAc(AC_SINGLE_PAIR);
    expect(applyLiteralEdit("a b c", "b", "b", false)).toEqual({
      kind: "invalid",
      reason: "same-text",
    });
    // Guard fires even when replaceAll is set and the text has many hits.
    expect(applyLiteralEdit("b b b", "b", "b", true)).toEqual({
      kind: "invalid",
      reason: "same-text",
    });
  });

  it("guards win over matching (invalid before zero/ambiguous)", () => {
    tagAc(AC_SINGLE_PAIR);
    expect(applyLiteralEdit("no hits here", "", "", false)).toEqual({
      kind: "invalid",
      reason: "empty-old",
    });
  });
});
