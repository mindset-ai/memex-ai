// spec-512 dec-4 — the CLAUDE.md standards index is GENERATED, and stays honest.
//
// THE DRIFT THIS ENDS (measured, not hypothetical): the index was hand-maintained
// and stopped at std-37, while std-38, std-39, std-40, std-41 and std-42 were all
// APPROVED in Memex. Five binding Standards were invisible to any agent orienting
// from the codebase pointer — so they bound nobody's behaviour.
//
// The pre-existing guard (spec-172-e2e-standard-index) pins that ONE row, std-28,
// exists. That is a presence check, not a completeness check, so adding a Standard
// left the pointer stale with nothing red. This file closes that.
//
// The generator introduces the repo's FIRST BEGIN/END generated region — every
// other generated artifact here is whole-file with a prose banner — so these tests
// deliberately hammer the documented marker failure mode: a generator that
// rewrites only the FIRST marked block passes its own check while leaving the file
// broken.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  BEGIN,
  END,
  renderTable,
  findRegions,
  applyRegions,
} from "../../../../scripts/ci/standards-index.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CLAUDE_MD = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "standards.manifest.json"), "utf8"),
);

describe("spec-512: the standards index is generated and complete", () => {
  it("CLAUDE.md's table matches the manifest exactly (ac-15)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-15");

    const handlesInFile = [...CLAUDE_MD.matchAll(/^\|\s*(std-\d+)\s*\|/gm)].map(
      (m) => m[1],
    );
    // Denominator: a broken regex here would make every assertion below vacuous.
    expect(
      handlesInFile.length,
      `Parsed ${handlesInFile.length} std-N rows out of CLAUDE.md — far too few to ` +
        `be the real index. The table shape or the regex has broken, which would ` +
        `make the completeness assertion below pass against nothing.`,
    ).toBeGreaterThan(30);

    const handlesInManifest = MANIFEST.standards.map(
      (s: { handle: string }) => s.handle,
    );
    const missing = handlesInManifest.filter(
      (h: string) => !handlesInFile.includes(h),
    );

    expect(
      missing,
      `Standards approved in the manifest but MISSING from the CLAUDE.md index: ` +
        `${missing.join(", ")}.\n\n` +
        `CLAUDE.md is how an agent discovers which rules bind it — an absent row ` +
        `means an approved Standard governs nobody.\n\n` +
        `Fix:\n  make standards-gen\n\n` +
        `Check: packages/server/src/__regression__/spec-512-standards-index.regression.test.ts`,
    ).toEqual([]);

    // The five that had actually drifted. Pinned by name so a regression is named,
    // not merely counted.
    for (const h of ["std-38", "std-39", "std-40", "std-41", "std-42"]) {
      expect(handlesInFile, `${h} must be indexed in CLAUDE.md`).toContain(h);
    }
  });

  it("the table sits inside generated markers (ac-15)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-15");
    expect(CLAUDE_MD).toContain(BEGIN);
    expect(CLAUDE_MD).toContain(END);
    const regions = findRegions(CLAUDE_MD);
    expect(regions.length).toBe(1);
    // The table must be INSIDE the region, not adjacent to it.
    const inner = CLAUDE_MD.slice(regions[0].start, regions[0].end);
    expect(inner).toMatch(/\|\s*std-1\s*\|/);
    expect(inner).toMatch(/\|\s*std-42\s*\|/);
  });
});

describe("spec-512: the generator handles EVERY marked region, not just the first", () => {
  const body = "GENERATED-BODY";

  it("rewrites all regions when a file has several (ac-15)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-15");

    // The documented failure mode: regenerate the first block, copy the rest
    // verbatim, pass your own check, ship a broken file.
    const doc = `intro\n${BEGIN}\nOLD-ONE\n${END}\nmiddle\n${BEGIN}\nOLD-TWO\n${END}\ntail\n`;
    const out = applyRegions(doc, body);

    expect(out).not.toContain("OLD-ONE");
    expect(
      out,
      "The SECOND generated region was left stale — a generator that rewrites only " +
        "the first block passes its own staleness check while the file is broken.",
    ).not.toContain("OLD-TWO");
    expect(out.split(body).length - 1).toBe(2);
    // Non-generated prose is preserved untouched.
    expect(out).toContain("intro");
    expect(out).toContain("middle");
    expect(out).toContain("tail");
  });

  it("refuses orphaned, unbalanced, out-of-order and nested markers (ac-15)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-15");

    const cases: Array<[string, string, RegExp]> = [
      ["orphan BEGIN", `a\n${BEGIN}\nb\n`, /Unbalanced generated markers/],
      ["orphan END", `a\n${END}\nb\n`, /Unbalanced generated markers/],
      ["no markers at all", `just prose\n`, /No generated region found/],
      ["reversed order", `${END}\nx\n${BEGIN}\n`, /out of order|Unbalanced/],
      [
        "nested",
        `${BEGIN}\n${BEGIN}\nx\n${END}\n${END}\n`,
        /Nested generated regions|out of order/,
      ],
    ];

    for (const [label, doc, expected] of cases) {
      expect(
        () => applyRegions(doc, body),
        `A ${label} must be REFUSED — a partial rewrite would corrupt the file, ` +
          `so the generator must write nothing and say why.`,
      ).toThrow(expected);
    }
  });

  it("the rendered table is derived from the manifest, in order (ac-15)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-15");

    const table = renderTable([
      { handle: "std-1", summary: "first" },
      { handle: "std-2", summary: "second" },
    ]);
    expect(table).toBe(
      "| Standard | Covers |\n|---|---|\n| std-1 | first |\n| std-2 | second |",
    );

    // And the real manifest is sorted, so the generated table reads in order.
    const nums = MANIFEST.standards.map((s: { handle: string }) =>
      Number(s.handle.slice(4)),
    );
    expect(nums).toEqual([...nums].sort((a: number, b: number) => a - b));
  });
});
