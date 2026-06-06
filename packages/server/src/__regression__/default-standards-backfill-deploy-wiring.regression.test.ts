// spec-184 t-4 / ac-15 — the existing-Memex default-Standards backfill runs
// automatically as part of the CI/CD deploy, with NO manual step, and CANNOT stall
// the deploy.
//
// deploy.yml runs the SAME packages/server/deploy.sh a human runs, so asserting the
// backfill is wired into that script proves the "automatic / no manual step" contract:
// every INT deploy (push to develop) and every PROD deploy (the develop→main promotion)
// executes it. Mirrored here as a static guard (matching spec-178's handhold backfill
// guard) so a future edit that drops the hook — or drops the `timeout` bound or the
// non-gating `||` — fails CI. The runtime idempotency / empty-list-only behaviour is
// covered by services/default-standards.integration.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SERVER_DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const DEPLOY_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");
const AC_15 = "mindset-prod/memex-building-itself/specs/spec-184/acs/ac-15";

const deploySh = readFileSync(SERVER_DEPLOY_SH, "utf-8");

// Anchor on the EXECUTABLE migrate line (`DATABASE_URL="${DB_URL}" pnpm db:migrate`),
// not the `# 1b. apply-hand-migrations.sh` comment near the top of the file — otherwise
// "backfill after migrations" would be satisfied by a doc comment and the ordering
// wouldn't actually be pinned.
const migrateIdx = deploySh.search(/DATABASE_URL="\$\{DB_URL\}"\s+pnpm db:migrate/);
const backfillIdx = deploySh.search(/DATABASE_URL="\$\{DB_URL\}"\s+timeout\s+\d+\s+pnpm db:backfill-default-standards/);
const killProxyIdx = deploySh.search(/kill\s+\$PROXY_PID/);

describe("spec-184 ac-15: the default-Standards backfill is wired into the CI/CD deploy (no manual step, bounded)", () => {
  it("packages/server/deploy.sh invokes the backfill", () => {
    tagAc(AC_15);
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
  });

  it("runs the backfill AFTER the database migrations", () => {
    tagAc(AC_15);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeGreaterThan(migrateIdx);
  });

  it("runs the backfill against the proxied DB while the cloud-sql-proxy is still up", () => {
    tagAc(AC_15);
    expect(deploySh).toMatch(/DATABASE_URL="\$\{DB_URL\}"\s+timeout\s+\d+\s+pnpm db:backfill-default-standards/);
    expect(killProxyIdx).toBeGreaterThan(backfillIdx);
  });

  it("BOUNDS the backfill with `timeout` so a hang can never stall the deploy", () => {
    tagAc(AC_15);
    expect(deploySh).toMatch(/timeout\s+\d+\s+pnpm db:backfill-default-standards/);
  });

  it("invokes the backfill NON-GATING — a timeout/failure cannot abort the deploy under set -e", () => {
    tagAc(AC_15);
    // Followed by `|| <fallback>`, so a non-zero exit (incl. timeout's 124) is swallowed.
    expect(deploySh).toMatch(/pnpm db:backfill-default-standards[\s\S]{0,200}\|\|/);
  });

  it("the deploy workflow runs the same deploy.sh, so the wiring actually executes in CI", () => {
    tagAc(AC_15);
    const workflow = readFileSync(DEPLOY_WORKFLOW, "utf-8");
    expect(workflow).toMatch(/bash deploy\.sh/);
  });
});
