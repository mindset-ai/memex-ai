// spec-178 t-5 / ac-28 — the existing-Memex Handhold backfill runs automatically
// as part of the CI/CD deploy, with NO manual step, and CANNOT stall the deploy.
//
// deploy.yml runs the SAME packages/server/deploy.sh a human runs, so asserting the
// backfill is wired into that script proves the "automatic / no manual step" contract:
// every INT deploy (push to develop) and every PROD deploy (the develop→main promotion)
// executes it. Mirrored here as a static guard so a future edit that drops the hook —
// or, just as important, drops the `timeout` bound — fails CI.
//
// History: an earlier unbounded version hung the INT deploy to the 30-min job timeout
// (the backfill awaited a standards drift scan per demo decision). The fix is twofold:
// demo seeding is now off the embedding + drift-scan paths (ac-42), AND the hook is
// bounded by `timeout` + non-gating so even a pathological hang can never abort a deploy.
// This guard nails down the deploy-wiring half (the runtime idempotency / no-double-seed
// half is covered by services/handhold-demo.integration.test.ts, and the agent-surface
// suppression by services/handhold-demo-agent-surface-exclusion.integration.test.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SERVER_DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const DEPLOY_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");
const AC_28 = "mindset-prod/memex-building-itself/specs/spec-178/acs/ac-28";

const deploySh = readFileSync(SERVER_DEPLOY_SH, "utf-8");

const migrateIdx = deploySh.search(/apply-hand-migrations\.sh|pnpm db:migrate/);
const backfillIdx = deploySh.search(/db:backfill-handhold|backfill-handhold-demo\.ts/);
const killProxyIdx = deploySh.search(/kill\s+\$PROXY_PID/);

describe("spec-178 ac-28: the Handhold backfill is wired into the CI/CD deploy (no manual step, bounded)", () => {
  it("packages/server/deploy.sh invokes the backfill", () => {
    tagAc(AC_28);
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
  });

  it("runs the backfill AFTER the database migrations", () => {
    tagAc(AC_28);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeGreaterThan(migrateIdx);
  });

  it("runs the backfill against the proxied DB while the cloud-sql-proxy is still up", () => {
    tagAc(AC_28);
    expect(deploySh).toMatch(/DATABASE_URL="\$\{DB_URL\}"\s+timeout\s+\d+\s+pnpm db:backfill-handhold/);
    expect(killProxyIdx).toBeGreaterThan(backfillIdx);
  });

  it("BOUNDS the backfill with `timeout` so a hang can never stall the deploy", () => {
    tagAc(AC_28);
    // The unbounded version hung to the 30-min job timeout. The bound is non-negotiable.
    expect(deploySh).toMatch(/timeout\s+\d+\s+pnpm db:backfill-handhold/);
  });

  it("invokes the backfill NON-GATING — a timeout/failure cannot abort the deploy under set -e", () => {
    tagAc(AC_28);
    // Followed by `|| <fallback>`, so a non-zero exit (incl. timeout's 124) is swallowed.
    expect(deploySh).toMatch(/pnpm db:backfill-handhold[\s\S]{0,200}\|\|/);
  });

  it("the deploy workflow runs the same deploy.sh, so the wiring actually executes in CI", () => {
    tagAc(AC_28);
    const workflow = readFileSync(DEPLOY_WORKFLOW, "utf-8");
    expect(workflow).toMatch(/bash deploy\.sh/);
  });
});
