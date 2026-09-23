// spec-510 t-7 (dec-6, dec-9 — ac-16/ac-17/ac-21): a kill switch that never
// reaches the running service.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. Wiring a runtime flag takes TWO edits in two files, and doing
// only the first produces no error anywhere:
//
//   1. `scripts/deploy-config.sh` — `if [ -n "${VAR+set}" ]; then export VAR; fi`
//      so a deploy from a checkout that never set the value cannot blast a
//      hand-set one.
//   2. `packages/server/deploy.sh` — `${VAR+|VAR=${VAR}}` inside the Cloud Run
//      `--update-env-vars` list, so the value actually reaches the service.
//
// Do (1) alone and the variable is exported into the deploy script's environment
// and then dropped on the floor. The flag reads its default forever. Nothing
// fails: not the deploy, not CI, not a smoke test. The switch LOOKS armed, in
// the config, in the comments, in the Spec — and it is not. That is the precise
// phrase dec-6 uses for the failure it wants avoided.
//
// MEASURED, NOT HYPOTHETICAL. This is how spec-510's own t-3 and t-4 shipped:
// both added the deploy-config passthrough and neither added the deploy.sh
// forwarding. At the moment this guard was written, 17 of the 19 passed-through
// variables appeared in the server deploy script and the only two missing were
// `GUIDANCE_CADENCE_ENABLED` and `HANDOFF_SHARED_STORE_ENABLED` — so the
// convention was universal and these two commits were the exception. The guard
// was watched RED on exactly that before the wiring was fixed.
//
// WHY A DERIVED SET AND NOT A LIST. A hardcoded list of flags to check would be
// correct on the day it was written and silently incomplete forever after — the
// next flag is precisely the one nobody remembers to add. So the expected set is
// PARSED out of deploy-config.sh at test time: adding a passthrough there is what
// puts a variable under this guard, with no second place to remember.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-510/acs/ac-${n}`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_CONFIG = join(REPO_ROOT, "scripts", "deploy-config.sh");
const SERVER_DEPLOY = join(REPO_ROOT, "packages", "server", "deploy.sh");

/**
 * Passed through deploy-config.sh, but consumed as a `gcloud` FLAG rather than
 * as a runtime environment variable — so these legitimately never appear in
 * `--update-env-vars`.
 *
 * An explicit, reviewed list of four. A new entry here is a visible claim that
 * the variable configures the deploy rather than the service; the alternative —
 * loosening the check — would let a real runtime flag slip through under the
 * same cover.
 */
const GCLOUD_FLAG_VARS: ReadonlySet<string> = new Set([
  "MIN_INSTANCES", // --min-instances
  "MAX_INSTANCES", // --max-instances
  "SERVICE_ACCOUNT", // --service-account
  "DB_POOL_MAX", // sizing arithmetic; also forwarded, but not required to be
]);

function passthroughVars(configSrc: string): string[] {
  // Matches the set-vs-unset idiom: if [ -n "${VAR+set}" ]; then export VAR; fi
  return [...configSrc.matchAll(/if \[ -n "\$\{([A-Z0-9_]+)\+set\}" \]/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

describe("spec-510 t-7 — a flag passed through the deploy config must reach the service", () => {
  it("every runtime passthrough var is forwarded to Cloud Run in conditional form", () => {
    tagAc(AC(16));
    tagAc(AC(17));
    const config = readFileSync(DEPLOY_CONFIG, "utf8");
    const deploy = readFileSync(SERVER_DEPLOY, "utf8");

    const expected = passthroughVars(config).filter((v) => !GCLOUD_FLAG_VARS.has(v));
    expect(expected.length, "parsed no passthrough vars — the idiom changed").toBeGreaterThan(5);

    const missing = expected.filter((v) => !deploy.includes(`\${${v}+|${v}=\${${v}}}`));

    expect(
      missing,
      `These variables are passed through scripts/deploy-config.sh but never forwarded ` +
        `to Cloud Run by packages/server/deploy.sh:\n` +
        missing.map((v) => `  - ${v}`).join("\n") +
        `\n\nThe deploy exports them and drops them. The running service never sees the ` +
        `value, so the flag reads its default forever and the switch is "armed and is not" ` +
        `(dec-6). Nothing else fails when this is wrong — not the deploy, not CI, not smoke.\n\n` +
        `Fix: add \${VAR+|VAR=\${VAR}} to the --update-env-vars list in ` +
        `packages/server/deploy.sh. The conditional form is required, not cosmetic: a plain ` +
        `VAR=\${VAR} would send an EMPTY value when unset, which RESETS a hand-set flag on ` +
        `the service — the exact accident the passthrough exists to prevent.\n\n` +
        `If the variable configures the deploy rather than the service, add it to ` +
        `GCLOUD_FLAG_VARS in this file with the flag it feeds.`,
    ).toEqual([]);
  });

  it("the forwarding is --update-env-vars, not --set-env-vars", () => {
    tagAc(AC(17));
    const deploy = readFileSync(SERVER_DEPLOY, "utf8");
    // The whole set-vs-unset design rests on this. `--set-env-vars` REPLACES the
    // service's entire environment, so any variable not named would be deleted —
    // and a flag omitted because it was unset in the config would be cleared
    // rather than preserved, inverting the guarantee.
    expect(deploy).toContain("--update-env-vars");
    expect(deploy).not.toContain("--set-env-vars");
  });

  it("both scripts still parse — a substring assertion cannot see a broken script", () => {
    tagAc(AC(17));
    // The checks above read these files as TEXT. Every one of them would pass
    // just as happily against a script bash refuses to run: the forwarding lives
    // inside a single ~4KB quoted argument, which is exactly the kind of line an
    // edit breaks by losing a brace or a quote. Since a deploy script is only
    // ever executed in anger, `bash -n` here is the cheapest place to find that.
    for (const script of [DEPLOY_CONFIG, SERVER_DEPLOY]) {
      expect(() => execFileSync("bash", ["-n", script], { stdio: "pipe" })).not.toThrow();
    }
  });

  it("spec-510's own two flags are wired end to end", () => {
    tagAc(AC(21));
    // Named explicitly as well as covered by the derived set above: these are the
    // two the guard was built after, and a regression on them specifically should
    // read as such rather than as an anonymous entry in a list.
    const config = readFileSync(DEPLOY_CONFIG, "utf8");
    const deploy = readFileSync(SERVER_DEPLOY, "utf8");
    for (const flag of ["GUIDANCE_CADENCE_ENABLED", "HANDOFF_SHARED_STORE_ENABLED"]) {
      expect(config, `${flag} lost its deploy-config passthrough`).toContain(
        `if [ -n "\${${flag}+set}" ]`,
      );
      expect(deploy, `${flag} is not forwarded to Cloud Run`).toContain(
        `\${${flag}+|${flag}=\${${flag}}}`,
      );
    }
  });
});
