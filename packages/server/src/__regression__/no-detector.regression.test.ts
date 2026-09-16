// spec-566 t-10 (dec-8) — the suite half of the twin guard [per std-2's pattern].
//
//   ac-25  "No prior statement text, statement hash, or verification-relative
//          timestamp is stored or compared anywhere in the gate's path — the
//          gate's only condition is that an unaccepted proposal exists. Proven
//          by a source scan alongside the behavioural test: dec-8 chose D
//          precisely to avoid a detector, and a detector added later 'for
//          safety' reintroduces the false-positive class this decision
//          eliminated."
//
// THE OFFLINE COPY IS THE ONE THAT MATTERS, and it is `scripts/check-no-detector.ts`
// in `make check`. ac-25 asked for that lane specifically because NO server
// vitest test is offline — the suite's globalSetup provisions a database — and
// `.husky/pre-push` skips `make check`. So the two lanes cover different
// failures: the offline copy is what a developer meets before a push, and THIS
// copy is what survives someone bypassing the hook.
//
// Both drive the same scanner module, so the rule has one definition. What this
// file adds is the MUTATION EVIDENCE: a scan that never fires guards nothing,
// and the only way to know it fires is to hand it the code it exists to refuse.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECLARED_IMPORTS,
  GATE_MODULE,
  formatDetectorFailure,
  importsOf,
  scanGateForDetectors,
  scanGateForUndeclaredImports,
  scanSourceForDetectors,
} from "../services/no-detector-scan.js";

const AC_25 = "mindset-prod/memex-building-itself/specs/spec-566/acs/ac-25";
const SRC = join(__dirname, "..");

describe("spec-566 ac-25 — the done-gate carries no change detector", () => {
  it("finds none on the real gate", () => {
    tagAc(AC_25);

    // Vacuity guard: the scanner must actually have read the gate. A missing or
    // renamed file would make "no violations" true for the wrong reason — and
    // `readFileSync` throwing is a louder failure than a silent pass, which is
    // why the scanner does not swallow it.
    const text = readFileSync(join(SRC, GATE_MODULE), "utf8");
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain("listDoneGateBlockers");

    expect(scanGateForDetectors(SRC)).toEqual([]);
    expect(scanGateForUndeclaredImports(SRC)).toEqual([]);
  });

  it("explains dec-8's reasoning rather than only going red", () => {
    tagAc(AC_25);

    // ac-25's second half, and t-10 says it in as many words: "the scan's job is
    // to hand the next author dec-8, not just to go red". A message that named
    // the line and stopped would send them to widen the scan.
    const message = formatDetectorFailure([
      {
        rule: "statement hash",
        line: 42,
        text: "const statementHash = createHash('sha256')…",
        because: "a hash of the statement is a change detector with extra steps.",
      },
    ]);

    expect(message).toContain("dec-8");
    // The decision, not just its name.
    expect(message).toContain("CLOSE THE SECOND DOOR");
    expect(message).toMatch(/unreachable/i);
    // The consequence, which is what makes "for safety" read as the mistake it is.
    expect(message).toMatch(/false-positive/i);
    expect(message).toContain("dec-7");
    // And the sanctioned way out, so the author changes the decision rather than
    // the guard.
    expect(message).toContain("change dec-8 first");
  });

  it("FIRES on each shape dec-8 ruled out — the mutation evidence", () => {
    tagAc(AC_25);

    // A scan that never fires guards nothing. These are the four shapes the
    // offline runner was probed with against the real file; asserting them
    // through the scanner keeps the evidence in the suite rather than in a
    // commit message.
    const gate = readFileSync(join(SRC, GATE_MODULE), "utf8");
    const anchor = "  if (blockers.length === 0) return;\n";
    expect(gate).toContain(anchor);

    const probes: [string, string][] = [
      ["statement hash", "  const statementHash = createHash('sha256').update(x).digest('hex');\n"],
      ["prior statement text", "  const previousStatement = blockers[0].statement;\n"],
      ["verification-relative timestamp", "  const verifiedAt = new Date();\n"],
      ["statement comparison", "  if (a.statement === b) { }\n"],
    ];

    for (const [rule, injected] of probes) {
      const mutated = gate.replace(anchor, anchor + injected);
      // The REAL scanner, over text — no second copy of the rules to drift, and
      // nothing written to the tree the suite is running in.
      const hits = scanSourceForDetectors(mutated).map((v) => v.rule);
      expect(hits, `${rule} must be caught`).toContain(rule);
    }

    // …and the unmutated file trips none of them, so the four above are about
    // the injection rather than about something already in the gate.
    expect(scanSourceForDetectors(gate)).toEqual([]);
  });

  it("names every declared import, so a new dependency cannot pass unnoticed", () => {
    tagAc(AC_25);

    // Scanning the gate alone would be defeated by moving the comparison into a
    // helper it imports. The tripwire is what makes that a decision rather than
    // an accident — probed separately with a benign import, because a crypto
    // import trips the content rules first and would prove nothing about this.
    const undeclared = scanGateForUndeclaredImports(SRC);
    expect(undeclared).toEqual([]);
    expect(DECLARED_IMPORTS.length).toBeGreaterThan(3);

    const gate = readFileSync(join(SRC, GATE_MODULE), "utf8");
    const withNewImport = gate.replace(
      'import { db } from "../db/connection.js";',
      'import { db } from "../db/connection.js";\nimport { timeAgo } from "@memex/shared";',
    );
    expect(withNewImport).not.toBe(gate);
    expect(importsOf(withNewImport).filter((s) => !DECLARED_IMPORTS.includes(s))).toEqual([
      "@memex/shared",
    ]);
  });
});
