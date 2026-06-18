import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// spec-302 t-3 / ac-7 — the @memex-ai-ac/vitest package must have its own CI job
// so its tagged tests EMIT on every PR. Without it the package's helper-side ACs
// (spec-302's, and spec-129's ac-16/ac-3) emit only via manual local runs and go
// stale (spec-302 issue-1).
//
// This guard deliberately lives in the SERVER suite — which IS run in CI with
// MEMEX_EMIT_KEY — so it itself emits reliably (a guard in the un-run package
// would have the very problem it checks for).
const AC_7 = "mindset-prod/memex-building-itself/specs/spec-302/acs/ac-7";

describe("CI runs the @memex-ai-ac/vitest package (spec-302 issue-1)", () => {
  it("test.yml has an ac-emit job that runs the package suite, wired with the emission key (ac-7)", () => {
    tagAc(AC_7);

    const wf = readFileSync(
      join(__dirname, "../../../../.github/workflows/test.yml"),
      "utf8",
    );

    // A dedicated top-level job exists.
    expect(wf).toMatch(/^ {2}ac-emit:/m);

    // Bound the assertions to the ac-emit job block (up to the next job comment).
    const start = wf.indexOf("ac-emit:");
    const end = wf.indexOf("# UI E2E", start);
    expect(end).toBeGreaterThan(start);
    const jobBlock = wf.slice(start, end);

    // It runs the emitter package's own suite…
    expect(jobBlock).toContain("pnpm --filter @memex-ai-ac/vitest test");
    // …wired with the emission key so its tagged tests actually emit.
    expect(jobBlock).toContain("MEMEX_EMIT_KEY: ${{ secrets.MEMEX_EMIT_KEY }}");
  });
});
