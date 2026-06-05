// spec-178 t-5 / ac-28 — the existing-memex Handhold backfill runs automatically
// as part of the CI/CD deploy, with NO manual step.
//
// The deploy workflow (.github/workflows/deploy.yml) runs the SAME
// packages/server/deploy.sh a human runs locally, so asserting the backfill is
// wired into that script proves the "automatic / no manual step" contract: every
// INT deploy (push to develop) and every PROD deploy (the develop→main promotion)
// executes it. It is mirrored here as a static guard so a future edit that drops
// the hook fails CI instead of silently un-wiring the backfill.
//
// This guard covers the DEPLOY-WIRING half of ac-28. The RUNTIME half — the
// backfill is idempotent, reuses seedHandholdDemo under the 0-demo guard, mutates
// via mutate(), and a re-deploy never double-seeds — is covered by the
// backfill/self-heal cases in services/handhold-demo.integration.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SERVER_DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const DEPLOY_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");
const AC_28 = "mindset-prod/memex-building-itself/specs/spec-178/acs/ac-28";

const deploySh = readFileSync(SERVER_DEPLOY_SH, "utf-8");

// Positions of the load-bearing landmarks in deploy.sh, reused across the
// ordering assertions below. -1 (not found) is asserted away in each test.
const migrateIdx = deploySh.search(/apply-hand-migrations\.sh|pnpm db:migrate/);
const backfillIdx = deploySh.search(/db:backfill-handhold|backfill-handhold-demo\.ts/);
const killProxyIdx = deploySh.search(/kill\s+\$PROXY_PID/);

describe("spec-178 ac-28: the Handhold backfill is wired into the CI/CD deploy (no manual step)", () => {
  it("packages/server/deploy.sh invokes the backfill", () => {
    tagAc(AC_28);
    // Tolerant of either the package script alias or the raw script path.
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
  });

  it("runs the backfill AFTER the database migrations", () => {
    tagAc(AC_28);
    // ac-28 depends on the is_demo column existing — the backfill must follow the
    // migration steps, never precede them.
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeGreaterThan(migrateIdx);
  });

  it("runs the backfill against the proxied DB while the cloud-sql-proxy is still up", () => {
    tagAc(AC_28);
    // Must use the same proxied DATABASE_URL the migrations used, and run before
    // the proxy is torn down (otherwise it has nothing to connect to).
    expect(deploySh).toMatch(/DATABASE_URL="\$\{DB_URL\}"\s+pnpm db:backfill-handhold/);
    expect(killProxyIdx).toBeGreaterThan(backfillIdx);
  });

  it("invokes the backfill NON-GATING — a failure cannot abort the deploy under set -e", () => {
    tagAc(AC_28);
    // The invocation is followed by `|| <fallback>`, so a non-zero exit is
    // swallowed and `set -e` cannot abort a live deploy over a data hiccup.
    expect(deploySh).toMatch(/pnpm db:backfill-handhold[\s\S]{0,160}\|\|/);
  });

  it("the deploy workflow runs the same deploy.sh, so the wiring actually executes in CI", () => {
    tagAc(AC_28);
    const workflow = readFileSync(DEPLOY_WORKFLOW, "utf-8");
    expect(workflow).toMatch(/bash deploy\.sh/);
  });
});
