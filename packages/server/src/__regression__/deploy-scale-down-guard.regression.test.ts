// The scale-down guard in packages/server/deploy.sh (Step 4a).
//
// WHAT IT PREVENTS. On 2026-08-07 a prod deploy silently reduced Cloud Run from
// minScale 1 / maxScale 8 to 0 / 3. The scaling flags substitute
// ${MIN_INSTANCES:-0} / ${MAX_INSTANCES:-3}; those two keys were absent from the env
// blob the deploy actually reads, so the defaults applied and gcloud re-asserted them
// over the live values (std-26 §6 cl-136 — a deploy destroys anything it fails to
// restate). MIN_INSTANCES/MAX_INSTANCES appeared ZERO times in the deploy log, so
// nothing about it was visible either during or after.
//
// WHY THESE TESTS EXECUTE THE SCRIPT RATHER THAN GREP IT. The sibling
// spec-518-scaling-budget regression test asserts statically that the flags read from
// env — and it passed on the day the reduction shipped, because presence of the
// mechanism was never the problem. A static assertion cannot tell you whether the
// guard actually refuses. So each case below EXTRACTS the real Step 4a block out of
// the real deploy.sh and RUNS it under bash with a stubbed `gcloud`, asserting the
// exit code and the operator-facing message. Re-implementing the logic here would
// only prove that this file's copy works, which is worthless — that mistake is
// precisely what spec-521's archived-guard tests were written to avoid.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_SH = readFileSync(join(REPO_ROOT, "packages", "server", "deploy.sh"), "utf-8");

// Pull the guard out of the shipped script by its step markers. If either marker ever
// moves or is renamed, extraction fails loudly rather than silently testing nothing —
// an empty block that "passes" would be the worst outcome here.
function extractGuardBlock(): string {
  const start = DEPLOY_SH.indexOf("# ── Step 4a: the scale-down guard");
  const end = DEPLOY_SH.indexOf("# ── Step 4b: Deploy to Cloud Run");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "could not extract Step 4a scale-down guard from deploy.sh — markers moved? " +
        `start=${start} end=${end}`,
    );
  }
  const block = DEPLOY_SH.slice(start, end);
  if (!block.includes("SCALE_DOWN_REPORT") || !block.includes("ALLOW_SCALE_DOWN")) {
    throw new Error("extracted block does not look like the scale-down guard");
  }
  return block;
}

const GUARD = extractGuardBlock();

interface RunOpts {
  liveMin: string;
  liveMax: string;
  minInstances?: string;
  maxInstances?: string;
  allowScaleDown?: string;
}

// Runs the REAL guard text with `gcloud` shadowed by a shell function. A bash function
// takes precedence over an executable of the same name, so the guard's own
// `_live_scale_annotation` calls land on the stub without the guard being modified.
function runGuard(o: RunOpts): { status: number; stdout: string; stderr: string } {
  const script = `
set -euo pipefail
ENV=prod
SERVICE=memex-api
REGION=us-east4
GCP_PROJECT=memex-ai-prod
gcloud() {
  case "$*" in
    *minScale*) printf '%s' "\${STUB_LIVE_MIN}" ;;
    *maxScale*) printf '%s' "\${STUB_LIVE_MAX}" ;;
    *) return 1 ;;
  esac
}
${GUARD}
`;
  const env: Record<string, string> = {
    ...process.env,
    STUB_LIVE_MIN: o.liveMin,
    STUB_LIVE_MAX: o.liveMax,
  };
  if (o.minInstances !== undefined) env.MIN_INSTANCES = o.minInstances;
  if (o.maxInstances !== undefined) env.MAX_INSTANCES = o.maxInstances;
  if (o.allowScaleDown !== undefined) env.ALLOW_SCALE_DOWN = o.allowScaleDown;
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("deploy.sh scale-down guard — the 2026-08-07 prod reduction cannot recur", () => {
  it("REPRODUCES the incident: live 1/8 with both keys unset is REFUSED", () => {
    // The exact 2026-08-07 shape — nothing set, defaults 0/3, live 1/8.
    const r = runGuard({ liveMin: "1", liveMax: "8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to reduce prod Cloud Run capacity");
    expect(r.stderr).toContain("min-instances: live 1 → would become 0");
    expect(r.stderr).toContain("max-instances: live 8 → would become 3");
  });

  it("names the DEFAULT as the cause, so the log says why", () => {
    const r = runGuard({ liveMin: "1", liveMax: "8" });
    expect(r.stderr).toContain("MAX_INSTANCES absent from scripts/deploy.prod.env");
  });

  it("names BOTH config stores — verifying the wrong one is how the incident happened", () => {
    const r = runGuard({ liveMin: "1", liveMax: "8" });
    expect(r.stderr).toContain("DEPLOY_ENV_FILE");
    expect(r.stderr).toContain("memex-prod-deploy-env");
  });

  it("allows the correct config through untouched (live 1/8 → 1/8)", () => {
    const r = runGuard({ liveMin: "1", liveMax: "8", minInstances: "1", maxInstances: "8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scale-down guard: OK");
  });

  it("allows scaling UP — the guard is one-directional", () => {
    const r = runGuard({ liveMin: "1", liveMax: "8", minInstances: "2", maxInstances: "16" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scale-down guard: OK");
  });

  it("refuses a partial reduction — max held, min dropped", () => {
    const r = runGuard({ liveMin: "1", liveMax: "8", minInstances: "0", maxInstances: "8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("min-instances: live 1 → would become 0");
    expect(r.stderr).not.toContain("max-instances: live");
  });

  it("ALLOW_SCALE_DOWN=1 permits a deliberate reduction, and says so loudly", () => {
    const r = runGuard({
      liveMin: "1",
      liveMax: "8",
      minInstances: "0",
      maxInstances: "3",
      allowScaleDown: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SCALE-DOWN GUARD OVERRIDDEN");
    expect(r.stdout).toContain("max-instances: live 8 → would become 3");
  });

  it("does not block a first-ever deploy, where there is no live service to compare", () => {
    const r = runGuard({ liveMin: "", liveMax: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("first deploy?");
  });

  it("still guards when only one annotation is readable", () => {
    // minScale absent on the live service, maxScale present — the max reduction must
    // still be caught rather than skipped because the pair was incomplete.
    const r = runGuard({ liveMin: "", liveMax: "8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("max-instances: live 8 → would become 3");
  });

  it("surfaces the connection-budget invariant before anyone raises MAX_INSTANCES", () => {
    // Raising max-instances to escape this guard is the obvious next move, and doing it
    // without the pool arithmetic is what caused the 2026-08-03 connection FATAL.
    const r = runGuard({ liveMin: "1", liveMax: "8" });
    expect(r.stderr).toContain("DB_POOL_MAX + 1");
  });
});

describe("deploy.sh scale-down guard — wiring", () => {
  it("runs BEFORE the gcloud run deploy it protects", () => {
    const guardAt = DEPLOY_SH.indexOf("# ── Step 4a: the scale-down guard");
    const deployAt = DEPLOY_SH.indexOf('gcloud run deploy "${SERVICE}"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deployAt);
  });

  it("compares against LIVE state rather than asserting the variables are set", () => {
    // The distinction matters: a required-variable check would pass the moment someone
    // set the keys in either store, including the wrong one. Comparing to live state is
    // what makes the guard indifferent to which store is at fault.
    expect(GUARD).toContain("gcloud run services describe");
    expect(GUARD).toContain("autoscaling.knative.dev/");
  });

  it("does not abort the deploy when the live lookup itself fails", () => {
    // `|| true` on the describe: a transient API error or a missing service must not
    // become a deploy outage under `set -e`.
    expect(GUARD).toContain("|| true");
  });
});
