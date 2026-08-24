// spec-538 t-4 (ac-15, ac-16) — the budget is enforced at the funnel, and a new
// caller cannot walk around it.
//
// dec-3 chose the funnel on STRUCTURE, not traffic. Verbose mutation calls are
// only ~174/month in prod, and twelve of the twenty-eight tools that route
// through `formatState` recorded none at all — `retitle_section`,
// `edit_section`, `delete_section`, `set_sensitive`, `supersede_spec`,
// `approve_candidate`, `reject_candidate`, `delete_decision`, `create_standard`,
// `accept_standard_change`, `add_clause`, `delete_clause`. They are not safe,
// they are unexercised. Enforcing per-site would have left every one of them
// exactly as exposed as before, and would not have covered the twenty-ninth
// caller written next month.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatState } from "../agent/handlers/shared.js";
import { RESPONSE_BODY_BUDGET_CHARS } from "../mcp/response-budget.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readAllSources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...readAllSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push({ file: full.slice(SRC.length + 1), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const SOURCES = readAllSources(SRC);

describe("the budget lives at the funnel, so every caller inherits it (ac-15)", () => {
  it("formatState bounds an oversized doc — the one path all 29 call sites use", async () => {
    tagAc(AC(15));
    const baseDate = new Date("2026-03-25T12:00:00Z");
    const doc = {
      id: "d1",
      memexId: "m1",
      handle: "spec-1",
      title: "Oversized",
      docType: "spec",
      status: "build",
      createdAt: baseDate,
      statusChangedAt: baseDate,
      version: 1,
      sensitive: false,
      sensitiveByName: null,
      checkedOutBy: null,
      checkedOutAt: null,
      sections: [
        {
          id: "s1",
          docId: "d1",
          sectionType: "overview",
          title: "Overview",
          // Larger than the whole measured client cap on its own — spec-472's
          // real shape is 85,580 chars of prose.
          content: "P".repeat(90_000),
          seq: 1,
          position: 1,
          status: "active",
          createdAt: baseDate,
          updatedAt: baseDate,
        } as unknown as DocSection,
      ],
    } as unknown as Doc & { sections: DocSection[] };

    const out = await formatState("https://example.test", {
      doc,
      decs: [],
      tasks: [],
    } as never);

    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
    expect(out).toContain("Response shape:");
  });

  it("every handler that renders doc state goes through that funnel — including the twelve unexercised tools", () => {
    tagAc(AC(15));
    // The twelve tools with zero recorded verbose traffic live in these files.
    // If any of them ever rendered doc state by another route, its file would
    // hold a `formatFullDocState(` call of its own.
    const handlerFiles = SOURCES.filter((s) =>
      s.file.startsWith("agent/handlers/"),
    );
    expect(handlerFiles.length).toBeGreaterThan(0);

    for (const { file, text } of handlerFiles) {
      if (file.endsWith("shared.ts")) continue; // shared.ts IS the funnel
      expect(
        text.includes("formatFullDocState("),
        `${file} renders doc state without going through formatState`,
      ).toBe(false);
    }
  });
});

describe("a thirtieth caller cannot bypass the bound by accident (ac-16)", () => {
  it("formatFullDocState has exactly ONE non-test caller, and it is the budgeted funnel", () => {
    tagAc(AC(16));
    const callers = SOURCES.filter(
      ({ text }) =>
        text.includes("formatFullDocState(") &&
        !text.includes("export function formatFullDocState("),
    ).map((s) => s.file);

    // Any new entry here is a caller that skipped `formatState` — the exact
    // regression this guard exists to catch. Adding one is allowed, but it must
    // be a conscious edit to this list in the same change, not a silent arrival.
    expect(callers).toEqual(["agent/handlers/shared.ts"]);
  });

  it("the funnel still asks for a budget — nobody removed the allocation and kept the shape", () => {
    tagAc(AC(16));
    const formatters = SOURCES.find((s) => s.file === "formatting/formatters.ts");
    expect(formatters).toBeDefined();
    // A guard on the caller list alone would pass happily if someone deleted the
    // allocation inside the funnel: the funnel would still be the only route,
    // and it would be routing to an unbounded render.
    expect(formatters!.text).toContain("allocateResponseBudget(");
    expect(formatters!.text).toMatch(/budget\.tier/);
    expect(formatters!.text).toMatch(/budget\.renderProseBodies/);
    expect(formatters!.text).toMatch(/budget\.perDecisionChars/);
  });
});
