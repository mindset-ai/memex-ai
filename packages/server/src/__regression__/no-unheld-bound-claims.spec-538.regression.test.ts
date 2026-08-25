// spec-538 t-8 (ac-6) — no comment in the codebase asserts a bound the code does
// not hold.
//
// `mcp/tools.ts:342` claimed the terse-by-default flip meant "the MCP surface no
// longer overflows the agent's tool-result budget on a large doc". It was
// measurably false — 23 spilled payloads across 14 Specs — and believing it is
// part of why the overflow went unfixed for two months. A false comment at a
// choke point is worse than none: it is what lets the next reader conclude the
// problem was already solved.
//
// This guard is deliberately narrow. It cannot judge whether an arbitrary
// comment is true, so it pins the one class of claim this Spec learned to
// distrust: prose asserting the response surface cannot overflow.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push({ file: full.slice(SRC.length + 1), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const SOURCES = sources(SRC);

/**
 * Comment lines that ASSERT the surface cannot overflow.
 *
 * Matching "no longer overflows" alone would be wrong in both directions: it
 * misses a reworded claim, and it fires on the corrected comment in
 * `mcp/tools.ts`, which quotes the old sentence to record that it was false.
 * So a line must both make the claim AND not be discussing it — the tell for the
 * latter is a quotation mark, which is how the correction cites the old wording.
 */
function claimsNoOverflow(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("//") && !t.startsWith("*")) return false;
  const lower = t.toLowerCase();

  // The claim must be about the RESPONSE surface, not about any bound at all.
  // A first pass matched "never exceed" anywhere and flagged four honest
  // comments — a connection-pool bound, an analytics-fidelity note, a bus-relay
  // note and a test-event log cap. None is about what the client will accept,
  // and a guard that cries wolf on them would be turned off within a week.
  const aboutTheResponse =
    /(response|payload|tool-result|tool result|result cap|context window|mcp surface|budget on a large doc)/.test(
      lower,
    );
  if (!aboutTheResponse) return false;

  const asserts =
    /(no longer|never|cannot|can't|does not|doesn't|won't)\s+(\w+\s+){0,3}(overflow|exceed|spill)/.test(
      lower,
    );
  if (!asserts) return false;

  // A quoted claim is a claim being discussed, not made.
  return !t.includes('"') && !t.includes("'");
}

describe("no comment asserts a bound the code does not hold (ac-6)", () => {
  it("the guard's own corpus is real — it read the tree, not an empty list", () => {
    tagAc(AC(6));
    // A file scan that silently found nothing would satisfy every assertion
    // below while checking nothing at all.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES.some((s) => s.file === "mcp/tools.ts")).toBe(true);
  });

  it("nothing in the server source claims the response surface cannot overflow", () => {
    tagAc(AC(6));
    const offenders: string[] = [];
    for (const { file, text } of SOURCES) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (claimsNoOverflow(lines[i])) {
          offenders.push(`${file}:${i + 1} — ${lines[i].trim()}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the specific claim that started this Spec is gone, and its correction is in place", () => {
    tagAc(AC(6));
    const tools = SOURCES.find((s) => s.file === "mcp/tools.ts");
    expect(tools).toBeDefined();
    // The claim no longer stands on its own…
    const standalone = tools!.text
      .split("\n")
      .filter((l) => claimsNoOverflow(l));
    expect(standalone).toEqual([]);
    // …and the correction says where the bound actually lives now, so a reader
    // who wants the guarantee is pointed at code rather than prose.
    expect(tools!.text).toContain("response-budget.ts");
  });

  it("the guard bites: a fresh unheld claim is caught", () => {
    tagAc(AC(6));
    // Proven inline rather than by editing a real file, so the check itself is
    // verified without leaving a deliberate defect behind for one test run.
    expect(claimsNoOverflow("  // the mcp surface no longer overflows the cap")).toBe(true);
    expect(claimsNoOverflow("  // responses can never exceed the client budget")).toBe(true);
    expect(claimsNoOverflow("  // this payload cannot spill to a file")).toBe(true);
    // …and stays quiet on honest bounds about something else entirely, which is
    // what four real comments in this tree turned out to be.
    expect(claimsNoOverflow("  // bounded so we never exceed the postgres-js pool")).toBe(false);
    expect(claimsNoOverflow("  // they can never exceed reality")).toBe(false);
    // …and does not fire on a claim being quoted and refuted.
    expect(
      claimsNoOverflow('  // used to claim "no longer overflows the budget" — false'),
    ).toBe(false);
    // …nor on prose that merely mentions overflow.
    expect(claimsNoOverflow("  // 23 payloads overflowed the cap and spilled")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ac-5 — the twice-re-homed question stops circulating.
//
// spec-245 dec-1 (2026-06-23) → spec-511 dec-1 (2026-07-25) → resolved never.
// Two months of circulation, during which the same read grew from 80k to 122k
// and dropped a safety signal. Both candidates are now REJECTED against
// spec-538's resolutions.
//
// This is deliberately NOT a code test: the state lives in the Memex, not the
// repo, so a source assertion could only ever check a comment about it. It is
// recorded here as a reviewed criterion instead — see the task's progress note
// and the rejection reasons on both decisions, which carry the full argument.
// Flipping this badge with a string-match on a comment is exactly the
// mcp/tools.ts:342 failure this file exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
