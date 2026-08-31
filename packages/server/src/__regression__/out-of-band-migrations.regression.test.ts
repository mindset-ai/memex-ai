// spec-520 t-4 (ac-9) — CREATE INDEX CONCURRENTLY must never reach the migration runner.
//
// The runner (`scripts/apply-hand-migrations.mjs`) wraps every migration in `sql.begin()`,
// and CONCURRENTLY cannot run inside a transaction block. A file that needs it therefore
// lives in `drizzle/out-of-band/`, which the runner's NON-recursive readdirSync cannot see.
//
// Both halves are pinned here because both are easy to undo by accident: someone adds
// CONCURRENTLY to a normal migration (fails at deploy, loudly), or someone makes the runner
// recursive to "pick up everything" (fails at deploy, also loudly, but after the recursive
// change looks like a tidy-up in review).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const AC_OUT_OF_BAND = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-39";
import { tagAc } from "@memex-ai-ac/vitest";

const drizzleDir = resolve(import.meta.dirname, "../../drizzle");

describe("spec-520 ac-39: out-of-band index builds stay out of the transactional runner", () => {
  it("no migration the runner picks up contains CREATE INDEX CONCURRENTLY", () => {
    tagAc(AC_OUT_OF_BAND);
    // Exactly the runner's own glob: readdirSync (non-recursive) filtered to .sql.
    const applied = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
    const offenders = applied.filter((f) => {
      // STRIP `--` COMMENT LINES FIRST. 0125 and 0131 both DISCUSS CONCURRENTLY at length —
      // explaining why they correctly chose a plain inline CREATE INDEX instead — and that
      // prose is exactly what we want future migrations to keep writing. A check that fails
      // on files for reasoning about the constraint would punish the documentation it
      // depends on. The first draft of this test did precisely that.
      const sqlOnly = readFileSync(resolve(drizzleDir, f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      return /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sqlOnly);
    });
    expect(offenders).toEqual([]);
  });

  it("the runner's directory read is NOT recursive, so out-of-band/ stays invisible", () => {
    tagAc(AC_OUT_OF_BAND);
    const runner = readFileSync(
      resolve(import.meta.dirname, "../../scripts/apply-hand-migrations.mjs"),
      "utf8",
    );
    // A `recursive: true` here would silently pull out-of-band files into a transaction and
    // break the deploy — after a change that reads as harmless tidying.
    expect(runner).toMatch(/readdirSync\(drizzleDir\)/);
    expect(runner).not.toMatch(/readdirSync\(drizzleDir,\s*\{[^}]*recursive/);
  });

  it("the out-of-band file exists and carries its apply + verify instructions", () => {
    tagAc(AC_OUT_OF_BAND);
    // A statement nobody knows how to run is not a migration, it is a note. The file has to
    // say how to apply it AND how to confirm the build did not leave an INVALID index —
    // invalid means never used by the planner but still maintained on every write.
    const oob = readFileSync(
      resolve(drizzleDir, "out-of-band/0138_spec520_ac_health_index.sql"),
      "utf8",
    );
    expect(oob).toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(oob).toMatch(/indisvalid/);
    expect(oob).toMatch(/HOW TO APPLY/);
  });
});
