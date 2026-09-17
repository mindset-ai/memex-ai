// spec-562 ac-8 — the deadline constant must carry its measurement.
//
// WHY THIS EXISTS. `30_000` and a number someone typed on a Tuesday evening look
// identical. Six months on, nobody can tell a measured value from a guess, and the
// only way to tell is a reason written beside it [per std-50 cl-6, cl-13].
//
// This session paid that cost twice in two days. drizzle/0089_activity_view.sql
// carried a confident header describing a view that three later migrations had
// redefined, and spec-563 was authored against it — two of its five acceptance
// criteria described work that had already shipped. A load-bearing fact living in
// prose that nothing protects is a fact with a half-life.
//
// WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It checks the SHAPE of the
// provenance, never its content: a date, a sample size, the source it was read
// from, and a condition that reopens it. Re-measuring and rewriting the numbers
// must keep this green — that is the whole point, since a test that pinned today's
// figures would make the honest act (updating them) look like a regression. Only
// DELETING the provenance reds it.
//
// This is the repo's first test asserting on a comment. Precedent for the shape,
// if not the target: deploy-script-parity.test.ts tests that a script can be
// REACHED rather than that it is correct — "implemented is not activated". This
// tests that a value can be EXPLAINED.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { MCP_DISPATCH_DEADLINE_MS } from "./dispatch-deadline.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-562/acs/ac-${n}`;

const SOURCE = readFileSync(join(__dirname, "dispatch-deadline.ts"), "utf8");
const DECL = "export const MCP_DISPATCH_DEADLINE_MS";

/** The doc comment immediately preceding the declaration — nothing else counts. */
function provenanceBlock(): string {
  const declAt = SOURCE.indexOf(DECL);
  expect(
    declAt,
    `${DECL} not found — the constant moved; re-ground this assertion`,
  ).toBeGreaterThan(0);
  const before = SOURCE.slice(0, declAt);
  const open = before.lastIndexOf("/**");
  const close = before.lastIndexOf("*/");
  // The block must be adjacent: a doc comment that belongs to something else,
  // with code in between, is not this value's provenance.
  if (open < 0 || close < open) return "";
  const between = before.slice(close + 2).trim();
  if (between.length > 0) return "";
  return before.slice(open, close + 2);
}

describe("spec-562 ac-8 — the deadline carries its measurement", () => {
  it("the constant is documented at its declaration, not elsewhere", () => {
    tagAc(AC(8));
    const block = provenanceBlock();
    expect(
      block,
      "no doc comment sits immediately above the constant — a bare number is indistinguishable from a guess",
    ).not.toBe("");
    // A one-liner cannot carry a measurement. This is a floor, not a target.
    expect(block.split("\n").length).toBeGreaterThan(8);
  });

  it("it says WHEN it was measured", () => {
    tagAc(AC(8));
    expect(
      provenanceBlock(),
      "no ISO date — a measurement with no date cannot be judged stale",
    ).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("it says WHAT it was measured from, and HOW MUCH", () => {
    tagAc(AC(8));
    const block = provenanceBlock();
    // The source, so a reader can reproduce the measurement rather than trust it.
    expect(block, "the data source is not named").toMatch(/mcp_tool_calls/);
    // A sample size, so a reader can weigh it. Shape, not value: any figure passes.
    expect(block, "no sample size — 878 calls and 8 calls read the same").toMatch(
      /[\d\s_,]{2,}\s*calls/i,
    );
  });

  it("it says WHEN TO DISTRUST IT — the reopen condition", () => {
    tagAc(AC(8));
    const block = provenanceBlock();
    // std-50 cl-8: a measurement of the present can falsify a bound but never
    // confirm one, so provenance without a reopen trigger is a claim that quietly
    // hardens into fact.
    expect(
      block,
      "no re-measurement trigger — the value would silently harden into a fact",
    ).toMatch(/re-?measure|reopen/i);
  });

  it("the provenance DECLARES the value in force, and it matches the constant", () => {
    tagAc(AC(8));
    tagAc(AC(14));
    // Third attempt at this assertion, and the first that can fail. Recorded
    // because the two dead ends are instructive:
    //
    //   1. Comparing the literal on the declaration line to the imported constant
    //      asserted nothing — both are read from the same source, so they cannot
    //      disagree.
    //   2. Searching the whole comment for the live value also passed on a wrong
    //      constant, because the provenance deliberately cites EARLIER values as
    //      history ("why this was 30 000 ms until 2026-09-17").
    //
    // Both were caught by mutating the constant and watching the test stay green.
    // The fix is a single declarative line: history may say anything, but exactly
    // one line states what is in force, and it is checked.
    const block = provenanceBlock();
    const declared = block.match(/IN FORCE:\s*([\d_ ]+)\s*ms/);
    expect(
      declared,
      "the provenance has no `IN FORCE: <n> ms` line — nothing states which value is current",
    ).not.toBeNull();
    const stated = Number(declared![1].replace(/[_ ]/g, ""));
    expect(
      stated,
      "the provenance declares a value the code does not use — confidently wrong, the way 0089_activity_view.sql misled spec-563",
    ).toBe(MCP_DISPATCH_DEADLINE_MS);
  });
});
