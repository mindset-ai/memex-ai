// spec-518: Cloud Run scaling is env-keyed, and the connection budget stays under the DB's
// usable ceiling. Static assertions on deploy.sh / deploy-config.sh (same shape as the
// spec-168 deploy-config regression tests) plus the budget-invariant arithmetic that the
// 2026-08-03 incident violated. Live per-env enforcement is the post-deploy check (ac-9);
// these guard the mechanism + the intended numbers so a regression fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-518";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_SH = readFileSync(join(REPO_ROOT, "packages", "server", "deploy.sh"), "utf-8");
const DEPLOY_CONFIG = readFileSync(join(REPO_ROOT, "scripts", "deploy-config.sh"), "utf-8");

// Per-instance DB footprint = DB_POOL_MAX + 1. The +1 is the spec-156 bus-relay LISTEN
// connection — one persistent connection per Cloud Run instance (db/connection.ts:29).
const connectionBudget = (maxInstances: number, dbPoolMax: number) =>
  maxInstances * (dbPoolMax + 1);

// Intended per-env scaling — the values carried in each memex-<env>-deploy-env secret.
//
// The ceiling here is the one the 2026-08-03 FATAL and the 2026-08-11 outage were measured
// against: max_connections 50 − superuser_reserved 3 = 47. **It is history, not today's number** —
// dec-2 raised max_connections to 200 on 2026-08-12, so prod now has 197 usable. The historical
// figure is kept deliberately, because the assertions below are about the incident configurations
// and would stop meaning anything against 197.
//
// Today's ceiling is not a constant anywhere: spec-518 t-7's guard READS it from Postgres at
// deploy time (`src/deploy/scaling-budget.ts`, exercised by
// spec-518-applied-scaling.regression.test.ts), precisely because a recorded ceiling outlived its
// machine here once already.
const INCIDENT_CEILING = 47;
const ENV_PLAN = {
  prod: { maxInstances: 8, dbPoolMax: 4, ceiling: INCIDENT_CEILING },
} as const;

describe("spec-518 ac-8: Cloud Run scaling flags are env-keyed with safe defaults", () => {
  it("deploy.sh sources --min-instances/--max-instances from env, defaulting to 0/3", () => {
    tagAc(`${SPEC}/acs/ac-8`);
    expect(DEPLOY_SH).toMatch(/--min-instances\s+"\$\{MIN_INSTANCES:-0\}"/);
    expect(DEPLOY_SH).toMatch(/--max-instances\s+"\$\{MAX_INSTANCES:-3\}"/);
  });

  it("deploy-config.sh exports MIN_INSTANCES/MAX_INSTANCES per-env", () => {
    tagAc(`${SPEC}/acs/ac-8`);
    expect(DEPLOY_CONFIG).toMatch(/export MIN_INSTANCES/);
    expect(DEPLOY_CONFIG).toMatch(/export MAX_INSTANCES/);
  });
});

describe("spec-518 ac-10: connection budget stays under the effective ceiling", () => {
  it("counts the +1 relay LISTEN per instance", () => {
    tagAc(`${SPEC}/acs/ac-10`);
    expect(connectionBudget(8, 4)).toBe(40); // prod: 8 × (4+1)
    expect(connectionBudget(3, 5)).toBe(18); // deploy.sh defaults: 3 × (5+1)
  });

  it("intended per-env values are under their ceilings", () => {
    tagAc(`${SPEC}/acs/ac-10`);
    for (const [env, p] of Object.entries(ENV_PLAN)) {
      expect(
        connectionBudget(p.maxInstances, p.dbPoolMax),
        `${env} over budget`,
      ).toBeLessThan(p.ceiling);
    }
  });

  it("regression: the 2026-08-03 mitigation (maxScale 8 × pool 5 = 48) is OVER the prod ceiling", () => {
    tagAc(`${SPEC}/acs/ac-10`);
    // This is the exact config that threw `FATAL: remaining connection slots` — the guard
    // that would have caught it: 8 × (5+1) = 48 ≥ 47.
    expect(connectionBudget(8, 5)).toBeGreaterThanOrEqual(ENV_PLAN.prod.ceiling);
  });

  it("the deploy.sh defaults (unset env) are budget-safe", () => {
    tagAc(`${SPEC}/acs/ac-10`);
    expect(connectionBudget(3, 5)).toBeLessThan(ENV_PLAN.prod.ceiling);
  });
});
