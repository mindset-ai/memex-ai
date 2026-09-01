// spec-545 t-3 / ac-10 — pin that the facet-tags backfill re-tags EVERYTHING unless
// `--gap-only` is passed explicitly.
//
// THIS IS A PIN, NOT AN ENDORSEMENT. spec-545 broadened the `architecture` facet
// description, and that description is the rubric the LLM classifier reads. Existing
// clause tags are safe from the reword because they are stored rows that nothing
// re-evaluates on read — with exactly one exception: a bare run of this script, which
// deletes and re-inserts a tag for every clause in the memex under the new wording.
// The Spec's Operations lens and ac-4 forbid that run. Those are prose, and prose goes
// stale silently; this guard fails the moment the flag's semantics change, so the
// warning gets revisited instead of quietly becoming a lie.
//
// WHY A SUBPROCESS rather than a source scan. The script calls main() at module scope,
// so it cannot be imported without running a backfill, and grepping for the literal
// "--gap-only" would pass against `const gapOnly = !argv.includes("--all")` — an
// inverted default with the same string in it. Running it is the only way to observe
// the DEFAULT rather than the spelling. The script prints its mode banner BEFORE it
// touches anything, so a nonexistent memex id gives a real reading for ~1s and a
// single failed read query; nothing is written and no model is called.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_10 = "mindset-prod/memex-building-itself/specs/spec-545/acs/ac-10";

const SERVER_ROOT = join(__dirname, "..", "..");
const TSX = join(SERVER_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = join("scripts", "backfill-facet-tags.ts");

/** The script's mode banner, run against a memex id that matches nothing. */
function bannerFor(args: readonly string[]): string {
  // A fresh id per call (std-37): nothing is inserted, but a shared literal is the
  // habit that bites the next test that does insert.
  const result = spawnSync(TSX, [SCRIPT, randomUUID(), ...args], {
    cwd: SERVER_ROOT,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, MEMEX_EMIT: "false" },
  });
  // The run exits non-zero once it reaches the database — irrelevant, and deliberately
  // not asserted on: the banner is already flushed by then, and pinning the exit code
  // would couple this guard to whether a throwaway id happens to resolve.
  const banner = (result.stdout ?? "")
    .split("\n")
    .find((line) => line.includes("[facet-backfill] classifying"));
  if (!banner) {
    throw new Error(
      `spec-545 ac-10: no mode banner on stdout — the script's output shape changed, so ` +
        `this guard can no longer read the default.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return banner;
}

describe("spec-545: the facet-tags backfill defaults to re-tagging everything (ac-10)", () => {
  it("without the flag, runs in FULL mode — the corpus-wide hazard ac-4 forbids", () => {
    tagAc(AC_10);
    expect(
      bannerFor([]),
      "a bare invocation no longer reports full mode; if the default was deliberately " +
        "flipped to gap-only, spec-545 ac-4 and its Operations warning must be revised, not this test",
    ).not.toContain("UNTAGGED");
  });

  it("with --gap-only, runs in gap mode", () => {
    tagAc(AC_10);
    expect(bannerFor(["--gap-only"])).toContain("UNTAGGED");
  });

  it("the flag is opt-in, so an unrelated argument does not enable gap mode", () => {
    tagAc(AC_10);
    // Guards against a loose match (e.g. `argv.some(a => a.includes("gap"))`) quietly
    // widening what counts as the flag.
    expect(bannerFor(["--gap"])).not.toContain("UNTAGGED");
  });
});
