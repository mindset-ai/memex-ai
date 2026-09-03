// spec-538 t-7 (ac-3, ac-17, ac-2) — the outcome the whole Spec was created for.
//
// spec-535 shipped a sensitivity flag rendered at the top of the full read.
// spec-533 was flagged. An agent read it, the 122k payload was refused by the
// client and written to a file, the warning landed on line 11 of that file, the
// agent grepped for its section with a pattern that never matched line 11, and
// wrote. The signal was dropped on exactly the class of Spec — long, heavily
// decided — that most warrants flagging.
//
// This file asserts the delivery, not the copy. Whether the words are the right
// words is spec-535's business; whether they ARRIVE is this Spec's.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  formatState,
} from "../agent/handlers/doc-state.js";
import { formatFullDocState } from "./formatters.js";
import { RESPONSE_BODY_BUDGET_CHARS } from "./response-budget.js";
import type { Doc, DocSection, Decision } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

function flaggedSpec(proseChars: number, decisionCount = 0): Doc & { sections: DocSection[] } {
  return {
    id: "d1",
    memexId: "m1",
    handle: "spec-1",
    title: "A sensitive Spec",
    docType: "spec",
    status: "build",
    createdAt: baseDate,
    statusChangedAt: baseDate,
    version: 1,
    sensitive: true,
    sensitiveByUserId: null,
    sensitiveByName: "the person to talk to",
    checkedOutBy: null,
    checkedOutAt: null,
    sections: [
      {
        id: "s1",
        docId: "d1",
        sectionType: "overview",
        title: "Overview",
        content: "P".repeat(proseChars),
        seq: 1,
        position: 1,
        status: "active",
        createdAt: baseDate,
        updatedAt: baseDate,
      } as unknown as DocSection,
    ],
  } as unknown as Doc & { sections: DocSection[] };
}

function decisions(n: number, resolutionChars: number): Decision[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `dec-${i}`,
    docId: "d1",
    seq: i + 1,
    title: `Decision ${i + 1}`,
    status: "resolved",
    resolution: "R".repeat(resolutionChars),
    context: "C".repeat(1_000),
    createdAt: baseDate,
    updatedAt: baseDate,
    resolvedAt: baseDate,
  })) as unknown as Decision[];
}

/** Every size class, so "delivery no longer depends on how much prose it has". */
const SIZES: Array<[label: string, prose: number, decs: number]> = [
  ["small — tier 1", 2_000, 2],
  ["tight — tier 2", 2_000, 12],
  ["oversized — tier 3", 90_000, 7],
  ["absurd", 900_000, 40],
];

describe("the signal reaches the reader on a Spec of ANY size (ac-3)", () => {
  for (const [label, prose, decs] of SIZES) {
    it(`carries the sensitivity warning and the contact — ${label}`, () => {
      tagAc(AC(3));
      const out = formatFullDocState(
        flaggedSpec(prose, decs),
        decisions(decs, 8_000),
        [],
      );

      expect(out).toContain("SENSITIVE");
      expect(out).toContain("the person to talk to");
      // …in the response itself, which is the whole point: a payload the client
      // refuses is a payload the reader never sees.
      expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
    });
  }

  it("delivery does not depend on how much prose the Spec has accumulated", () => {
    tagAc(AC(3));
    const renders = SIZES.map(([, prose, decs]) =>
      formatFullDocState(flaggedSpec(prose, decs), decisions(decs, 8_000), []),
    );
    // The warning is present in every one, and the responses differ wildly in
    // size — which is exactly the dependency this Spec removes.
    expect(renders.every((r) => r.includes("SENSITIVE"))).toBe(true);
    expect(new Set(renders.map((r) => r.length)).size).toBeGreaterThan(1);
  });
});

describe("a verbose WRITE on a flagged Spec now delivers the warning (ac-17)", () => {
  it("the verbose-write path is bounded, so the warning arrives instead of spilling", async () => {
    tagAc(AC(17));
    // `sections.ts:550` renders full doc state when ctx.verbose is set — the
    // branch that made spec-535 ac-25 unsatisfiable, because the response it
    // rode was relocated to a file.
    const out = await formatState("https://example.test", {
      doc: flaggedSpec(90_000),
      decs: decisions(7, 8_000),
      tasks: [],
    } as never);

    expect(out).toContain("SENSITIVE");
    expect(out).toContain("the person to talk to");
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("records what this Spec does NOT deliver: the terse-write path still says nothing", () => {
    tagAc(AC(17));
    // spec-535 dec-8 resolved to a one-line pointer prepended at
    // `services/spec-traffic.ts:205`, beside `phaseNote`. It was never built —
    // no task was created for it, and spec-535 went to `done` with ac-25/26/27
    // untested. Grepping that seam for any sensitivity handling finds nothing.
    //
    // This assertion exists so the gap is visible from the suite rather than
    // from someone re-reading two Specs. When spec-535 builds dec-8, this test
    // is the one to update — and spec-535 ac-25 is the one to re-tag.
    const src = readFileSync(
      fileURLToPath(new URL("../services/spec-traffic.ts", import.meta.url)),
      "utf8",
    );
    // Prove the read worked before trusting what it did not find: an empty
    // string would satisfy a `not.toContain` and assert nothing at all.
    expect(src.length).toBeGreaterThan(1_000);
    expect(src).toContain("phaseNote");
    expect(src.toLowerCase()).not.toContain("sensitive");
  });
});

describe("bounding never became refusing (ac-2, spec-535 ac-3)", () => {
  it("an oversized flagged Spec still renders, and still names every decision", () => {
    tagAc(AC(2));
    const decs = decisions(7, 8_000);
    const out = formatFullDocState(flaggedSpec(90_000, 7), decs, []);

    // Nothing threw, and the map is actionable: every decision is named, with
    // its status and the ref that now fetches it in full (t-10).
    for (const d of decs) {
      expect(out).toContain(`Decision ${d.seq}`);
      expect(out).toContain(`ref: dec-${d.seq}`);
    }
    expect(out).toContain("RESOLVED");
  });

  it("every section keeps a ref even when its body is withheld", () => {
    tagAc(AC(2));
    const out = formatFullDocState(flaggedSpec(90_000), [], []);
    expect(out).toContain("body not included");
    expect(out).toMatch(/Section #1 \| ref: s-1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The relay ask (2026-08-26, from a field report on spec-533).
//
// Deliberately UNTAGGED. spec-535 owns this copy and is `done`, so there is no
// acceptance criterion claiming this line — inventing a tag to turn a badge
// green would be the dishonesty this Spec keeps arguing against. The change is
// recorded on spec-535 issue-4, the open collector for field observations.
// ─────────────────────────────────────────────────────────────────────────────
describe("the block asks to be relayed, not just read", () => {
  it("carries an explicit relay instruction, and it survives every tier", () => {
    for (const [prose, decs] of [[2_000, 2], [2_000, 12], [90_000, 7]] as const) {
      const out = formatFullDocState(
        flaggedSpec(prose, decs),
        decisions(decs, 8_000),
        [],
      );
      expect(out).toContain("SENSITIVE");
      expect(out.toLowerCase()).toContain("do not summarise it away");
    }
  });

  it("says nothing new on an unflagged Spec", () => {
    const out = formatFullDocState(
      { ...flaggedSpec(2_000, 2), sensitive: false, sensitiveByName: null } as never,
      [],
      [],
    );
    expect(out.toLowerCase()).not.toContain("do not summarise");
  });
});
