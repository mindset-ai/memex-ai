// spec-542 t-5 (ac-1, ac-8) — the grounding state, in the HEADER, before any
// content, in every state, with its provenance.
//
// t-3/t-4 fixed the FOOTER: it no longer asserts a state it does not know. This
// is the other half of the report — the agent could not SEE the flag at all.
// The footer rides the bottom of a long read; ac-1 asks for the header, where an
// agent reads it before acting. That is spec-371's stated reason for
// `Checked out by:` being there, and grounding answers a question of the same
// shape: has this been checked against real code, by whom, when.
//
// EMITTED IN EVERY STATE, never signalled by absence. The precedent is
// `Response shape:` (spec-538 ac-13), whose own comment gives the rule:
// "Emitted at EVERY tier ... because 'absence means complete' is the inference
// this line exists to remove." Here the inference to remove is "absence means
// ungrounded" — which is the defect this Spec exists to fix, one step quieter.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState } from "./formatters.js";
import { CODE_GROUNDING_HEADER_PROSE } from "@memex/shared";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "formatters.ts");
const formattersSrc = readFileSync(SRC, "utf-8");

const baseDate = new Date("2026-01-01T00:00:00Z");

function makeDoc(
  overrides: Partial<Doc> & { groundedStale?: boolean } = {},
): Doc & { sections: DocSection[]; groundedStale?: boolean } {
  return {
    id: "spec-uuid-542",
    memexId: "memex-building-itself",
    handle: "spec-542",
    title: "Grounding header spec",
    docType: "spec",
    description: null,
    skillCapabilities: null,
    status: "specify",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    archiveReason: null,
    archivedByUserId: null,
    archivedByName: null,
    supersededByDocId: null,
    supersededAt: null,
    supersessionNote: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    groundedInCode: false,
    groundedAt: null,
    groundedByUserId: null,
    groundedByName: null,
    sensitive: false,
    sensitiveByUserId: null,
    sensitiveByName: null,
    checkedOutBy: null,
    checkedOutAt: null,
    checkedOutThread: null,
    version: 1,
    ...overrides,
    sections: [
      {
        id: "s-uuid-1",
        docId: "spec-uuid-542",
        sectionType: "overview",
        title: "Overview",
        description: null,
        content: "Body.",
        seq: 1,
        createdAt: baseDate,
        updatedAt: baseDate,
      } as DocSection,
    ],
  } as Doc & { sections: DocSection[]; groundedStale?: boolean };
}

const render = (o: Partial<Doc> & { groundedStale?: boolean } = {}) =>
  formatFullDocState(makeDoc(o), [], []);

/** The header is everything before the first section body. */
const headerOf = (out: string) => out.split("Body.")[0];

const GROUNDED = {
  groundedInCode: true,
  groundedAt: baseDate,
  groundedByName: "A. Reviewer",
};

describe("spec-542 — the grounding state is legible in the header (ac-1)", () => {
  it("an UNGROUNDED Spec says so, in the header", () => {
    tagAc(AC(1));

    const header = headerOf(render({ groundedInCode: false }));
    expect(header).toContain(CODE_GROUNDING_HEADER_PROSE.none);
  });

  it("a GROUNDED Spec names WHO and WHEN", () => {
    tagAc(AC(1));

    // The half the report was really about: the badge exists in the web UI and
    // the MCP read rendered nothing at all.
    const header = headerOf(render({ ...GROUNDED, groundedStale: false }));
    expect(header).toMatch(/Code-grounding:/);
    expect(header).toContain("A. Reviewer");
  });

  it("a STALE grounding is distinguishable from a fresh one in the header", () => {
    tagAc(AC(1));

    const fresh = headerOf(render({ ...GROUNDED, groundedStale: false }));
    const stale = headerOf(render({ ...GROUNDED, groundedStale: true }));
    expect(stale).not.toBe(fresh);
    expect(stale).toContain("A. Reviewer");
  });

  it("provenance comes from the denormalised name, and absence is not faked", () => {
    tagAc(AC(1));

    // std-32: groundedByName is stamped at write so a later rename cannot
    // rewrite history. When it is absent the line must still render the STATE —
    // degrading to silence would drop the signal exactly when attribution
    // failed — without naming nobody as if it were somebody.
    const header = headerOf(
      render({ groundedInCode: true, groundedAt: baseDate, groundedStale: false }),
    );
    expect(header).toMatch(/Code-grounding:/);
    expect(header).not.toMatch(/by (null|undefined)/);
  });

  it("the line renders in EVERY state — never signalled by absence", () => {
    tagAc(AC(1));

    // The `Response shape:` rule (spec-538 ac-13) applied here. A line that
    // appeared only when grounded would rebuild this defect quietly, because
    // the reader would then infer state from silence.
    for (const o of [
      { groundedInCode: false },
      { ...GROUNDED, groundedStale: false },
      { ...GROUNDED, groundedStale: true },
    ]) {
      expect(headerOf(render(o)), `no grounding line for ${JSON.stringify(o)}`).toMatch(
        /Code-grounding:/,
      );
    }
  });

  it("the line precedes the content it describes", () => {
    tagAc(AC(1));

    const out = render({ groundedInCode: false });
    expect(out.indexOf("Code-grounding:")).toBeGreaterThan(-1);
    expect(out.indexOf("Code-grounding:")).toBeLessThan(out.indexOf("Body."));
  });

  it("a non-Spec doc gets no grounding line", () => {
    tagAc(AC(1));

    // Grounding is a Spec concept. A free-form document has no decisions to
    // check against source, so the honest output is nothing.
    const header = headerOf(render({ docType: "document", status: "draft" }));
    expect(header).not.toMatch(/Code-grounding:/);
  });
});

describe("spec-542 — the header line obeys std-15 and the budget rules (ac-8)", () => {
  it("the prose lives in the Scaffold, not in server/src", () => {
    tagAc(AC(8));

    // std-15: agent-facing prose has one home. This file is NOT on the drift
    // guard's allowlist, so an inline sentence here would fail the build — but
    // the intent is asserted directly rather than left to a guard whose failure
    // would read as unrelated.
    expect(CODE_GROUNDING_HEADER_PROSE.none.length).toBeGreaterThan(0);
    expect(formattersSrc).toContain("CODE_GROUNDING_HEADER_PROSE");
    expect(formattersSrc).not.toContain(CODE_GROUNDING_HEADER_PROSE.none);
  });

  it("the grounding lines are pushed one at a time, not as a block", () => {
    tagAc(AC(8));

    // The std-15 drift guard (scaffold-drift-guard.regression.test.ts) owns the
    // "no markdown-shaped literal in server/src" rule and is the authority on
    // it; this asserts only the narrow thing it can see soundly — that the
    // lines THIS Spec added carry no embedded newline.
    //
    // A first version tried to re-implement the guard here with
    // /`[^`]*\n[^`]*\n[^`]*`/ and matched 269 "literals" — the regex spans
    // ordinary code between a closing and the next opening backtick, and
    // backticks also appear in comments as markdown code spans. It would have
    // been red for reasons unrelated to the change, and green only by accident.
    const pushes = formattersSrc
      .split("\n")
      .filter((l) => l.includes("CODE_GROUNDING_HEADER_PROSE"));
    expect(pushes.length, "expected the header pushes to be present").toBeGreaterThan(0);
    for (const line of pushes) {
      expect(line, `a grounding push spans lines: ${line}`).not.toMatch(/\\n/);
    }
  });

  it("the grounding line is emitted at every response tier, never rationed", () => {
    tagAc(AC(8));

    // spec-538 ac-9: "Signals are never rationed to buy room." A huge doc must
    // not lose the grounding line to make space for prose.
    const huge = makeDoc({ ...GROUNDED, groundedStale: false });
    huge.sections = [
      {
        ...huge.sections[0],
        content: "x".repeat(400_000),
      } as DocSection,
    ];
    const out = formatFullDocState(huge, [], []);
    expect(out).toMatch(/Response shape: (EXCERPTED|SECTION MAP)/);
    expect(out, "the grounding line was dropped to buy room").toMatch(/Code-grounding:/);
  });
});
