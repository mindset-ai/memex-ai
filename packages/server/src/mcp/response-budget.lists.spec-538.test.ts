// spec-538 t-5 (ac-20, ac-21, ac-26) — the formatters that grow without a bound.
//
// dec-5's first resolution saw one growth axis (item bodies) and missed the
// other (item count). `list_docs` was measured on its DEFAULT path at 467 docs
// × 187 chars = 88,494 — refused by the client, spilled to a file, on the
// highest-traffic read of the whole surface. One line per item is not a bound,
// it is a coefficient.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { boundRenderedList, RESPONSE_BODY_BUDGET_CHARS } from "./response-budget.js";
import { formatDocComments } from "../formatting/formatters.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocComment, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

/** The measured shape of a real list_docs line. */
const DOC_LINE = "x".repeat(187);

describe("boundRenderedList — item count is a growth axis too (ac-21)", () => {
  it("bounds the real list_docs shape that spills today: 467 lines of 187 chars", () => {
    tagAc(AC(21));
    const entries = Array.from({ length: 467 }, () => DOC_LINE);
    const unbounded = entries.join("\n").length;
    expect(unbounded).toBeGreaterThan(RESPONSE_BODY_BUDGET_CHARS); // 87,626 — the defect

    const { kept, omitted } = boundRenderedList(entries, { reservedChars: 500 });

    expect(kept.join("\n").length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS - 500);
    expect(omitted).toBeGreaterThan(0);
    expect(kept.length + omitted).toBe(467); // nothing is lost from the count
  });

  it("leaves a list that fits completely untouched (ac-26)", () => {
    tagAc(AC(26));
    const entries = Array.from({ length: 20 }, () => DOC_LINE);
    const { kept, omitted } = boundRenderedList(entries);

    expect(omitted).toBe(0);
    expect(kept).toEqual(entries);
  });

  it("keeps whole entries — never half of one", () => {
    tagAc(AC(21));
    const entries = Array.from({ length: 1_000 }, (_, i) => `${i}:${DOC_LINE}`);
    const { kept } = boundRenderedList(entries);
    for (const k of kept) {
      expect(entries).toContain(k);
    }
  });

  it("honours the caller's reservation, so the marker cannot push it over", () => {
    tagAc(AC(21));
    const entries = Array.from({ length: 1_000 }, () => DOC_LINE);
    const generous = boundRenderedList(entries, { reservedChars: 0 });
    const reserved = boundRenderedList(entries, { reservedChars: 10_000 });
    expect(reserved.kept.length).toBeLessThan(generous.kept.length);
    expect(reserved.kept.join("\n").length).toBeLessThanOrEqual(
      RESPONSE_BODY_BUDGET_CHARS - 10_000,
    );
  });
});

function makeComment(seq: number, bodyChars: number): DocComment {
  return {
    id: `c-uuid-${seq}`,
    docId: "doc-uuid-1",
    seq,
    sectionId: "section-uuid-1",
    decisionId: null,
    taskId: null,
    // A sentinel that cannot occur in surrounding prose. An earlier version used
    // "C" and the assertion matched the C in "Comments" — assert on a token the
    // formatter can never emit by accident.
    content: "\u00A7".repeat(bodyChars),
    commentType: "discussion",
    source: "agent",
    authorName: "someone",
    resolvedAt: null,
    createdAt: baseDate,
    updatedAt: baseDate,
  } as unknown as DocComment;
}

const SECTION = {
  id: "section-uuid-1",
  docId: "doc-uuid-1",
  sectionType: "overview",
  title: "Overview",
  seq: 1,
} as unknown as DocSection;

function commentsResult(comments: DocComment[]) {
  return {
    sections: [{ section: SECTION, comments }],
    decisions: [],
    tasks: [],
  } as never;
}

describe("list_comments — bodies are the other growth axis (ac-20)", () => {
  it("bounds a Spec carrying more comment prose than one response can hold", () => {
    tagAc(AC(20));
    // spec-510 reached ~55% of the cap on ten real comments; this is that curve
    // continued to where it breaks.
    const many = Array.from({ length: 40 }, (_, i) => makeComment(i + 1, 4_000));
    const out = formatDocComments(commentsResult(many));

    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
    expect(out).toContain("not shown");
    // The count is honest: the header still reports the true total.
    expect(out).toContain("# Comments (40 total)");
  });

  it("never cuts a comment in half — an omitted comment is absent, not truncated", () => {
    tagAc(AC(20));
    const many = Array.from({ length: 40 }, (_, i) => makeComment(i + 1, 4_000));
    const out = formatDocComments(commentsResult(many));

    // Every run of body characters in the output is a WHOLE body. A shorter run
    // would be a comment cut in half — the failure this asserts against.
    const runs = out.match(/\u00A7+/g) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.length).toBe(4_000);
    }
  });

  it("renders a Spec with a handful of comments exactly as before (ac-26)", () => {
    tagAc(AC(26));
    const few = Array.from({ length: 3 }, (_, i) => makeComment(i + 1, 200));
    const out = formatDocComments(commentsResult(few));

    expect(out).not.toContain("not shown");
    // All three bodies present, in full.
    expect(out.split("\u00A7".repeat(200)).length - 1).toBe(3);
  });
});

describe("the bounded shape reaches the real caller (ac-20)", () => {
  it("list_docs routes its entries through the bound rather than joining them raw", () => {
    tagAc(AC(20));
    // Honest about the level: the arithmetic is proven above against the real
    // measured shape (467 x 187), and this asserts the handler actually uses it.
    // What is NOT covered is an end-to-end call with several hundred seeded
    // documents — that needs an integration fixture, and its absence is recorded
    // on the task rather than papered over.
    const src = readFileSync(
      fileURLToPath(new URL("../agent/handlers/docs.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("boundRenderedList(");
    // …and the raw join it replaced is gone, so the bound cannot be bypassed by
    // a leftover code path.
    expect(src).not.toMatch(/docs\s*\n?\s*\.map\([^)]*\)\s*\n?\s*\.join\("\\n"\)/);
  });
});
