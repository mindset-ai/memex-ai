// spec-518: Cloud Run scaling is env-keyed, and the connection budget stays under the DB's
// usable ceiling. Static assertions on deploy.sh / deploy-config.sh (same shape as the
// spec-168 deploy-config regression tests) plus the budget-invariant arithmetic that the
// 2026-08-03 incident violated. Live per-env enforcement is the post-deploy check (ac-9);
// these guard the mechanism + the intended numbers so a regression fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  CUTOVER_REVISION_FACTOR,
  RELAY_LISTEN_PER_INSTANCE,
  computeBudget,
  usableConnections,
} from "../deploy/scaling-budget.js";

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

// ── ac-4 ─────────────────────────────────────────────────────────────────────
//
// "The invariant holds for the chosen values AND is documented with the arithmetic,
// reconciled with spec-332 dec-3 and connection.ts's budget comment."
//
// The second half is the one that rots, and it rotted here: until 2026-08-15
// connection.ts still described prod as db-custom-1-3840 / max_connections=50 with a
// steady-state budget of 3 × (5 + 1) = 18. Three places document this budget —
// connection.ts (which sizes the pool), deploy.sh (which applies it), and
// scaling-budget.ts (which asserts it) — and a criterion that says "documented and
// reconciled" is only meaningful if something checks they still say the same thing.
const CONNECTION_TS = readFileSync(
  join(REPO_ROOT, "packages", "server", "src", "db", "connection.ts"),
  "utf-8",
);
const PROD_APPLIED = [
  { service: "memex-api", maxInstances: 8, dbPoolMax: 4, ownCode: true },
  { service: "backstage", maxInstances: 3, ownCode: false },
];
const PROD_USABLE = usableConnections({ maxConnections: 200, superuserReserved: 3, reserved: 0 });

describe("spec-518 ac-4: the invariant holds, and the three places documenting it agree", () => {
  it("holds for the values prod actually runs", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    const budget = computeBudget({ services: PROD_APPLIED, usable: PROD_USABLE });
    expect(PROD_USABLE).toBe(197);
    expect(budget.peakTotal).toBe(151);
    expect(budget.withinBudget).toBe(true);
  });

  it("connection.ts documents the CURRENT budget, not the one it was born with", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // The stale claims, named individually so a failure says WHICH one came back.
    expect(CONNECTION_TS).not.toMatch(/prod is now db-custom-1-3840/);
    expect(CONNECTION_TS).not.toMatch(/steady-state budget is 3 × \(5 \+ 1 LISTEN\) = 18/);
    // And the current ones.
    expect(CONNECTION_TS).toMatch(/max_connections=200/);
    expect(CONNECTION_TS).toMatch(/197/);
  });

  it("all three documenting sites carry the SUM, not the single-term product", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // spec-332 dec-3 re-derived this on 2026-06-23: the ceiling is consumed through
    // several doors and the single-term form counted one. Each site must show the
    // cutover factor, because that is the term whose absence caused 2026-08-11.
    for (const [name, text] of [
      ["connection.ts", CONNECTION_TS],
      ["deploy.sh", DEPLOY_SH],
    ] as const) {
      expect(text, `${name} lost the cutover term`).toMatch(/2 × MAX_INSTANCES|2 × maxInstances|2 × 8/);
      expect(text, `${name} lost the relay LISTEN term`).toMatch(/relay LISTEN|\+ 1 LISTEN|\+ 1 relay/);
    }
    // The executable form these comments describe.
    expect(CUTOVER_REVISION_FACTOR).toBe(2);
    expect(RELAY_LISTEN_PER_INSTANCE).toBe(1);
  });
});

// ── ac-11 ────────────────────────────────────────────────────────────────────
//
// "This Spec's code diff introduces no Cloud SQL capacity change — no tier edit, no
// max_connections flag change, no connection pooler, no migration. Any capacity change
// is performed as a separate, logged operational act, never carried in a merge."
//
// dec-2 DID raise max_connections 50 → 200 — by `gcloud sql instances patch`, by hand,
// recorded on the decision. That separation is what makes a capacity change
// independently reviewable and independently reversible instead of entangled with a
// code release, so it is worth a guard rather than a promise.
const DRIZZLE_DIR = join(REPO_ROOT, "packages", "server", "drizzle");
const DEPLOY_SCRIPTS = [
  join(REPO_ROOT, "deploy.sh"),
  join(REPO_ROOT, "packages", "server", "deploy.sh"),
  join(REPO_ROOT, "packages", "ui", "deploy.sh"),
  join(REPO_ROOT, "scripts", "deploy-config.sh"),
];

/** Shell/SQL with comment lines removed — a capacity change is code, not prose. */
const stripComments = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(#|--)/.test(line))
    .join("\n");

describe("spec-518 ac-11: capacity changes are an operational act, never carried in a merge", () => {
  it("no migration touches connection capacity", () => {
    tagAc(`${SPEC}/acs/ac-11`);
    const migrations = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0); // the scan must actually scan something
    for (const file of migrations) {
      const sql = stripComments(readFileSync(join(DRIZZLE_DIR, file), "utf-8"));
      expect(sql, `${file} changes connection capacity`).not.toMatch(
        /max_connections|ALTER\s+SYSTEM/i,
      );
    }
  });

  it("no deploy script patches the instance's tier or database flags", () => {
    tagAc(`${SPEC}/acs/ac-11`);
    for (const path of DEPLOY_SCRIPTS) {
      const script = stripComments(readFileSync(path, "utf-8"));
      expect(script, `${path} performs a capacity change`).not.toMatch(
        /gcloud sql instances (patch|create)|--database-flags|--tier[= ]/,
      );
    }
    // The guard READS the ceiling from Postgres; it must never be able to change it.
    const guard = readFileSync(
      join(REPO_ROOT, "packages", "server", "scripts", "verify-scaling-budget.ts"),
      "utf-8",
    );
    expect(guard).not.toMatch(/gcloud sql instances (patch|create)|--database-flags/);
  });
});

// ── ac-18 ────────────────────────────────────────────────────────────────────
//
// "scripts/deploy.env.example and deploy.yml's header state what is actually true."
//
// The example advertising DB_POOL_MAX=10 for prod was not merely stale: at MAX_INSTANCES
// 8 a well-meaning "restore the documented value" is 8 × 11 = 88, the 2026-08-03
// exhaustion. Documentation that invites the incident deserves a test.
const DEPLOY_EXAMPLE = readFileSync(join(REPO_ROOT, "scripts", "deploy.env.example"), "utf-8");
const DEPLOY_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "deploy.yml"), "utf-8");

describe("spec-518 ac-18: the templates and the workflow header state what is true", () => {
  it("deploy.env.example does not advertise DB_POOL_MAX=10 as prod's value", () => {
    tagAc(`${SPEC}/acs/ac-18`);
    expect(DEPLOY_EXAMPLE).toMatch(/PROD RUNS DB_POOL_MAX="4", NOT 10/);
    expect(DEPLOY_EXAMPLE).not.toMatch(/^\s*DB_POOL_MAX="10"/m);
  });

  it("deploy.env.example's ceiling is today's, not the one both incidents were measured against", () => {
    tagAc(`${SPEC}/acs/ac-18`);
    // The live claim must be current; the ~47 may still appear as HISTORY, which is why
    // this pins the specific stale sentence rather than the number.
    expect(DEPLOY_EXAMPLE).not.toMatch(/prod: ~47 usable of max_connections=50/);
    expect(DEPLOY_EXAMPLE).toMatch(/197 usable/);
  });

  it("deploy.yml no longer claims CI and laptops share one mechanism with zero drift", () => {
    tagAc(`${SPEC}/acs/ac-18`);
    // They shared a FILE while obeying different SOURCES, and that sentence is what let
    // the bypass persist unexamined for weeks.
    expect(DEPLOY_YML).not.toMatch(/zero[- ]drift/i);
  });
});
