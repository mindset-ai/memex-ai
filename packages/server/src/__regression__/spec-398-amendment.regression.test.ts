// spec-520 ac-15 — spec-398's retention tests assert the time bound, not a count of 10.
//
// ac-15 has two halves. The first — that spec-398 ac-5 and ac-6 were AMENDED — is a fact
// about Memex, applied on 2026-08-31 and recorded in c-17; no code test can observe it.
// The second is a fact about THIS repository, and it is the half that rots: a future edit
// restoring a `toBe(RETENTION_KEEP)` assertion, or reintroducing the constant, would put
// spec-398's criteria and its tests back into contradiction with nothing to catch it.
//
// WHY IT MATTERS BEYOND TIDINESS. spec-398 is a DONE Spec. Its ACs are green and nobody
// revisits them. If its tests drift back to asserting count-based retention while its
// criteria state a time bound, the Spec reports "verified" for a property the code no
// longer has — and it would report that for as long as nobody happened to read both.
// That is precisely the drift SDD exists to make impossible (std-20).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_AMENDED = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-15";
const SRC = join(__dirname, "..");

function body(rel: string): string {
  // Strip line comments: this file's own explanatory prose names the very symbols it
  // forbids, and so does the retention test's header. Matching raw text would fail on
  // documentation rather than on code.
  return readFileSync(join(SRC, rel), "utf-8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

describe("spec-520 ac-15 — spec-398's retention tests assert the time bound", () => {
  it("no longer asserts a count of 10 via RETENTION_KEEP", () => {
    tagAc(AC_AMENDED);
    const t = body("services/spec-398-retention.integration.test.ts");
    // The exact shape ac-15 names: `expect(await countFor(...)).toBe(RETENTION_KEEP)`.
    expect(t).not.toMatch(/RETENTION_KEEP/);
  });

  it("the trim it used to call no longer exists to be called", () => {
    tagAc(AC_AMENDED);
    const mod = body("services/test-event-retention.ts");
    // Both halves of "trimTestEventsForPair and RETENTION_KEEP no longer exist" — a
    // leftover export is an invitation to reintroduce the 13.4% with a one-line edit.
    expect(mod).not.toMatch(/export\s+(async\s+)?function\s+trimTestEventsForPair/);
    expect(mod).not.toMatch(/export\s+const\s+RETENTION_KEEP/);
  });

  it("states retention as configuration, which is what the amended criteria now claim", () => {
    tagAc(AC_AMENDED);
    const mod = body("services/test-event-retention.ts");
    // spec-398 ac-6 now reads "the window is configuration-driven, not a compiled-in
    // constant" (c-17). This is the code side of that sentence.
    expect(mod).toMatch(/TEST_EVENTS_RETENTION_DAYS/);
    expect(mod).toMatch(/process\.env\.TEST_EVENTS_RETENTION_DAYS/);
  });
});
