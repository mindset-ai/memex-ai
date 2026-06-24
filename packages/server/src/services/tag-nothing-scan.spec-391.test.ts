// Unit tests for the tag-nothing scan core (spec-391 t-5, ac-12 / ac-4).
//
// The scan is pure (no DB, no filesystem): given a test file's source it counts
// cases and detects AC tagging; rankTagNothingFiles filters + ranks. The script
// (scripts/tag-nothing-report.mjs) is the I/O wrapper; this proves the logic.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { scanTestSource, rankTagNothingFiles } from "./tag-nothing-scan.js";

const SPEC391 = "mindset-prod/memex-building-itself/specs/spec-391";

describe("scanTestSource (spec-391 ac-12)", () => {
  it("counts test cases and flags a file that tags no ACs", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    const src = `
      import { it, describe } from "vitest";
      describe("thing", () => {
        it("does A", () => {});
        it("does B", () => {});
        test("does C", () => {});
      });
    `;
    const r = scanTestSource(src);
    expect(r.caseCount).toBe(3);
    expect(r.tagsAcs).toBe(false);
  });

  it("recognises tagAc / emitAcEvents / installAcEmission as tagging", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    expect(scanTestSource(`it("x", () => { tagAc("a/b/specs/spec-1/acs/ac-1"); });`).tagsAcs).toBe(true);
    expect(scanTestSource(`it("x", async () => { await emitAcEvents([], "pass", "id", 1); });`).tagsAcs).toBe(true);
    expect(scanTestSource(`installAcEmission(test, import.meta.url, {});`).tagsAcs).toBe(true);
  });

  it("counts it.only / it.each / test.skip variants as cases", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    const src = `
      it.only("a", () => {});
      it.each([1,2])("b %s", () => {});
      test.skip("c", () => {});
    `;
    expect(scanTestSource(src).caseCount).toBe(3);
  });

  it("a file with zero cases is not a candidate", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    expect(scanTestSource(`export const helper = 1;`).caseCount).toBe(0);
  });
});

describe("rankTagNothingFiles (spec-391 ac-12 / ac-4)", () => {
  it("returns only files with cases-but-no-tags, ranked by case count desc", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    tagAc(`${SPEC391}/acs/ac-4`);
    const ranked = rankTagNothingFiles([
      { file: "z.test.ts", result: { caseCount: 2, tagsAcs: false } },
      { file: "a.test.ts", result: { caseCount: 5, tagsAcs: false } },
      { file: "tagged.test.ts", result: { caseCount: 9, tagsAcs: true } }, // excluded
      { file: "empty.test.ts", result: { caseCount: 0, tagsAcs: false } }, // excluded
    ]);
    expect(ranked.map((r) => r.file)).toEqual(["a.test.ts", "z.test.ts"]);
    expect(ranked[0].caseCount).toBe(5);
  });

  it("ties on case count break by file name (stable)", () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    const ranked = rankTagNothingFiles([
      { file: "b.test.ts", result: { caseCount: 3, tagsAcs: false } },
      { file: "a.test.ts", result: { caseCount: 3, tagsAcs: false } },
    ]);
    expect(ranked.map((r) => r.file)).toEqual(["a.test.ts", "b.test.ts"]);
  });
});
