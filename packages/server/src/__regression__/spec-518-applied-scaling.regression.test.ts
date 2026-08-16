// spec-518 t-7 — the guard every existing check cannot be.
//
// The sibling file spec-518-scaling-budget.regression.test.ts asserts the SOURCE:
// deploy.sh's flag syntax, deploy-config.sh's exports, the intended arithmetic. Every one
// of those assertions was GREEN throughout the 2026-08-11 outage, because none of them can
// observe that CI never ran the exporting branch. They read intent; the defect lives in the
// outcome.
//
// So these tests cover the logic of a guard that reads back what a deploy APPLIED, and they
// exist as a separate file to keep that distinction legible rather than blurring it into the
// source-reading suite (t-7's own rationale for not widening t-3).
//
// Three claims are under test:
//   ac-16  the budget is checked against values in force, with every term counted
//   ac-19  a budget violation aborts on prod and warns on int (dec-5)
//   ac-20  an applied-vs-intended mismatch is fatal everywhere; an absent prod value too
//
// The live half of the guard (ac-14: it really reads the running revision) is NOT provable
// here. It is proved by the deploy running it on int, then prod — see t-7.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  ADMIN_SESSION_RESERVE,
  CUTOVER_REVISION_FACTOR,
  FOREIGN_SERVICE_DEFAULT_POOL,
  comparePlan,
  computeBudget,
  decideOutcome,
  parseRevisionScaling,
  parseServingRevisions,
  planEmissions,
  serviceTerm,
  usableConnections,
} from "../deploy/scaling-budget.js";
import { DEFAULT_POOL_MAX } from "../db/pool-size.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-518/acs";
const AC_APPLIED_BUDGET = `${SPEC}/ac-16`;
const AC_PER_ENV_POSTURE = `${SPEC}/ac-19`;
const AC_MISMATCH_FATAL = `${SPEC}/ac-20`;

// ── The two environments, measured 2026-08-14 from pg_settings through a proxy ──
// NOT from `gcloud sql describe`'s recorded flags: dec-2's whole thesis is that the value
// recorded is not the value in force.
const PROD_CEILING = { maxConnections: 200, superuserReserved: 3, reserved: 0 }; // → 197
const INT_CEILING = { maxConnections: 25, superuserReserved: 3, reserved: 0 }; //   →  22

// ── What prod actually serves, read back from the running revisions 2026-08-14 ──
const PROD_APPLIED = [
  { service: "memex-api", revision: "memex-api-00130-hgj", maxInstances: 8, dbPoolMax: 4, ownCode: true },
  // backstage shares memex-prod and carries NO pool cap — issue-2's uncounted consumer.
  { service: "backstage", revision: "backstage-00050-9kn", maxInstances: 3, ownCode: false },
];

// int is deliberately unset (t-4), so it runs deploy.sh's 0/3 defaults and the code's pool.
const INT_APPLIED = [
  { service: "memex-api", revision: "memex-api-00623-zpb", maxInstances: 3, ownCode: true },
];

describe("spec-518 ac-16: the budget counts values in force, and every term", () => {
  it("usable connections subtract BOTH reservations, not just the superuser one", () => {
    tagAc(AC_APPLIED_BUDGET);
    expect(usableConnections(PROD_CEILING)).toBe(197);
    expect(usableConnections(INT_CEILING)).toBe(22);
    // PG17 has reserved_connections too; it is 0 today and must still be subtracted, or the
    // guard's ceiling silently drifts the day someone sets it.
    expect(usableConnections({ maxConnections: 200, superuserReserved: 3, reserved: 10 })).toBe(187);
  });

  it("a per-instance term is pool + 1, and the +1 is the spec-156 relay LISTEN", () => {
    tagAc(AC_APPLIED_BUDGET);
    const term = serviceTerm({ service: "memex-api", maxInstances: 8, dbPoolMax: 4, ownCode: true });
    expect(term.perInstance).toBe(5);
    expect(term.steady).toBe(40);
    // A deploy runs the draining and starting revisions together, and a draining instance
    // holds its pool while serving nothing — so the peak is up to 2 × maxInstances.
    expect(term.peak).toBe(80);
    expect(CUTOVER_REVISION_FACTOR).toBe(2);
  });

  it("a service with NO pool cap contributes its default, never zero", () => {
    tagAc(AC_APPLIED_BUDGET);
    // This is the missing-term failure mode itself: an unconfigured consumer currently
    // contributes nothing to the arithmetic while consuming connections in reality.
    const foreign = serviceTerm({ service: "backstage", maxInstances: 3, ownCode: false });
    expect(foreign.poolMax).toBe(FOREIGN_SERVICE_DEFAULT_POOL);
    expect(foreign.poolSource).toBe("foreign-default");
    expect(foreign.steady).toBe(33);

    // For OUR OWN image the default is knowable, so the guard reads it from the code rather
    // than restating it — this is why the number cannot drift from what the pool really does.
    const ours = serviceTerm({ service: "memex-api", maxInstances: 3, ownCode: true });
    expect(ours.poolMax).toBe(DEFAULT_POOL_MAX);
    expect(ours.poolSource).toBe("our-code-default");
    // Over-counting a foreign service fails safe; under-counting is the defect.
    expect(FOREIGN_SERVICE_DEFAULT_POOL).toBeGreaterThan(DEFAULT_POOL_MAX);
  });

  it("prod's applied configuration is within budget today, with the margin stated", () => {
    tagAc(AC_APPLIED_BUDGET);
    const budget = computeBudget({ services: PROD_APPLIED, usable: usableConnections(PROD_CEILING) });
    expect(budget.steadyTotal).toBe(40 + 33 + ADMIN_SESSION_RESERVE);
    expect(budget.peakTotal).toBe(80 + 66 + ADMIN_SESSION_RESERVE);
    expect(budget.withinBudget).toBe(true);
    expect(budget.headroom).toBe(197 - (80 + 66 + ADMIN_SESSION_RESERVE));
  });

  it("the budget ENUMERATES what it counted, so a third consumer cannot be silently omitted", () => {
    tagAc(AC_APPLIED_BUDGET);
    const budget = computeBudget({ services: PROD_APPLIED, usable: 197 });
    expect(budget.terms.map((t) => t.service)).toEqual(["memex-api", "backstage"]);
    // The defect here was never a wrong number — it was a missing term. A check that names
    // its terms is the only kind that notices a new one.
    const withAThird = computeBudget({
      services: [...PROD_APPLIED, { service: "some-new-worker", maxInstances: 10, ownCode: false }],
      usable: 197,
    });
    expect(withAThird.terms).toHaveLength(3);
    expect(withAThird.peakTotal).toBeGreaterThan(budget.peakTotal);
  });

  it("restoring the DB_POOL_MAX=10 that deploy.env.example advertises FAILS the budget", () => {
    tagAc(AC_APPLIED_BUDGET);
    // ac-16 names this case: 8 × 11 = 88 is the 2026-08-03 exhaustion, and it must fail
    // against the ceiling of the day — against 47 outright, and against today's 197 once
    // the cutover term and backstage are counted.
    const poolTen = [{ ...PROD_APPLIED[0], dbPoolMax: 10 }, PROD_APPLIED[1]];
    expect(serviceTerm(poolTen[0]).steady).toBe(88);
    expect(computeBudget({ services: poolTen, usable: 47 }).withinBudget).toBe(false);
    expect(computeBudget({ services: poolTen, usable: 197 }).withinBudget).toBe(false);
  });
});

describe("spec-518 ac-19: prod aborts, int warns — same arithmetic, different exit (dec-5)", () => {
  // int violates the corrected invariant TODAY: 2 × 3 × (5+1) = 36 against 22 usable. It
  // survives because int's load never extends the pools; the bound is real arithmetic about
  // a peak int does not run. Measured, not assumed — int's max_connections is 25.
  const intBudget = computeBudget({ services: INT_APPLIED, usable: usableConnections(INT_CEILING) });

  it("int's applied configuration really does violate the corrected invariant", () => {
    tagAc(AC_PER_ENV_POSTURE);
    expect(intBudget.steadyTotal).toBe(18 + ADMIN_SESSION_RESERVE);
    expect(intBudget.peakTotal).toBe(36 + ADMIN_SESSION_RESERVE);
    expect(intBudget.withinBudget).toBe(false);
  });

  it("on int that violation warns and does NOT abort", () => {
    tagAc(AC_PER_ENV_POSTURE);
    const outcome = decideOutcome({ env: "int", budget: intBudget });
    expect(outcome.fatal).toBe(false);
    expect(outcome.warnings.join(" ")).toMatch(/budget/i);
    // Silence would be the other failure: the truth is stated either way.
    expect(outcome.warnings).not.toHaveLength(0);
  });

  it("the SAME violation on prod aborts", () => {
    tagAc(AC_PER_ENV_POSTURE);
    const outcome = decideOutcome({ env: "prod", budget: intBudget });
    expect(outcome.fatal).toBe(true);
    expect(outcome.failures.join(" ")).toMatch(/budget/i);
  });

  it("prod's real configuration is not fatal — the guard does not block a healthy deploy", () => {
    tagAc(AC_PER_ENV_POSTURE);
    const budget = computeBudget({ services: PROD_APPLIED, usable: 197 });
    const outcome = decideOutcome({ env: "prod", budget });
    expect(outcome.fatal).toBe(false);
    expect(outcome.failures).toHaveLength(0);
    expect(outcome.warnings).toHaveLength(0);
  });
});

describe("spec-518 ac-20: a mismatch is fatal in every environment", () => {
  const INTENDED_PROD = { MAX_INSTANCES: "8", MIN_INSTANCES: "1", DB_POOL_MAX: "4" };

  it("the 2026-08-11 red case: sourced 8, applied 3 — fatal", () => {
    tagAc(AC_MISMATCH_FATAL);
    const comparison = comparePlan({
      env: "prod",
      intended: INTENDED_PROD,
      applied: { MAX_INSTANCES: "3", MIN_INSTANCES: "1", DB_POOL_MAX: "4" },
    });
    expect(comparison.mismatches).toEqual([{ key: "MAX_INSTANCES", intended: "8", applied: "3" }]);
    expect(decideOutcome({ env: "prod", comparison }).fatal).toBe(true);
    // No per-env excuse: a value that is set and does not arrive is a plumbing defect, and
    // int is exactly where it must be caught, because int is deployed first.
    expect(decideOutcome({ env: "int", comparison }).fatal).toBe(true);
  });

  it("a value declared in the secret but ABSENT from the running revision is a mismatch", () => {
    tagAc(AC_MISMATCH_FATAL);
    // This was prod's real state until rev 00128: DB_POOL_MAX=4 declared, the serving
    // revision still carrying what it started with. Declared and in force are two facts.
    const comparison = comparePlan({
      env: "prod",
      intended: INTENDED_PROD,
      applied: { MAX_INSTANCES: "8", MIN_INSTANCES: "1", DB_POOL_MAX: undefined },
    });
    expect(comparison.mismatches).toEqual([
      { key: "DB_POOL_MAX", intended: "4", applied: undefined },
    ]);
    expect(decideOutcome({ env: "prod", comparison }).fatal).toBe(true);
  });

  it("matching values compare clean, numerically not textually", () => {
    tagAc(AC_MISMATCH_FATAL);
    const comparison = comparePlan({
      env: "prod",
      intended: INTENDED_PROD,
      applied: { MAX_INSTANCES: "08", MIN_INSTANCES: "1", DB_POOL_MAX: "4" },
    });
    expect(comparison.mismatches).toHaveLength(0);
    expect(decideOutcome({ env: "prod", comparison }).fatal).toBe(false);
  });

  it("an ABSENT scaling value is fatal on prod — silence must not become a live default", () => {
    tagAc(AC_MISMATCH_FATAL);
    // `${MAX_INSTANCES:-3}` turns a missing value into a live configuration change. That is
    // the trap, and it is the default rather than the arithmetic.
    const comparison = comparePlan({
      env: "prod",
      intended: { MAX_INSTANCES: "8", MIN_INSTANCES: undefined, DB_POOL_MAX: "4" },
      applied: { MAX_INSTANCES: "8", MIN_INSTANCES: "0", DB_POOL_MAX: "4" },
    });
    expect(comparison.missing).toEqual(["MIN_INSTANCES"]);
    const outcome = decideOutcome({ env: "prod", comparison });
    expect(outcome.fatal).toBe(true);
    expect(outcome.failures.join(" ")).toMatch(/MIN_INSTANCES/);
  });

  it("the same absence on int is NOT a mismatch — unset is int's chosen posture (t-4)", () => {
    tagAc(AC_MISMATCH_FATAL);
    const comparison = comparePlan({
      env: "int",
      intended: { MAX_INSTANCES: undefined, MIN_INSTANCES: undefined, DB_POOL_MAX: undefined },
      applied: { MAX_INSTANCES: "3", MIN_INSTANCES: "0", DB_POOL_MAX: undefined },
    });
    expect(comparison.mismatches).toHaveLength(0);
    expect(comparison.missing).toHaveLength(0);
    expect(comparison.ignored).toEqual(["MAX_INSTANCES", "MIN_INSTANCES", "DB_POOL_MAX"]);
    expect(decideOutcome({ env: "int", comparison }).fatal).toBe(false);
  });

  it("traffic left on an older revision is itself the applied-vs-intended gap", () => {
    tagAc(AC_MISMATCH_FATAL);
    // A rollout that reported success while traffic stayed on the previous revision would
    // pass every value comparison against a revision nobody is being served.
    const split = decideOutcome({
      env: "int",
      revision: { serving: ["memex-api-00622-abc"], expectedLatestReady: "memex-api-00623-zpb" },
    });
    expect(split.fatal).toBe(true);
    expect(split.failures.join(" ")).toMatch(/traffic/i);

    const clean = decideOutcome({
      env: "int",
      revision: { serving: ["memex-api-00623-zpb"], expectedLatestReady: "memex-api-00623-zpb" },
    });
    expect(clean.fatal).toBe(false);
  });
});

describe("spec-518 ac-20: the guard can SEE what config set — a third state, not two", () => {
  // Found by the guard's own first prod run (2026-08-14, run 31832139745), which aborted at the
  // pre-flight reporting `DB_POOL_MAX is ABSENT from prod config` while `memex-prod-deploy-env`
  // carried DB_POOL_MAX=4 and Cloud Run was applying it.
  //
  // Both facts were true. `deploy.sh`'s own gcloud line reads the value through
  // ${DB_POOL_MAX+|DB_POOL_MAX=...}, which expands in THAT shell, where a plain sourced
  // assignment is visible — so prod has run the right pool all along. But a plain assignment is
  // not exported, and the guard is a CHILD process. MIN_INSTANCES / MAX_INSTANCES already carried
  // explicit export guards for exactly this reason; DB_POOL_MAX never needed one until something
  // outside the deploy shell had to read it.
  //
  // So the Spec's "declared vs in force" pair is really a triple: declared, in force, and VISIBLE
  // to whatever is checking. int could not have caught this — int genuinely does not set the value,
  // so its guard run was correct and silent.
  const DEPLOY_CONFIG = readFileSync(
    join(__dirname, "..", "..", "..", "..", "scripts", "deploy-config.sh"),
    "utf-8",
  );

  it.each(["MIN_INSTANCES", "MAX_INSTANCES", "DB_POOL_MAX"])(
    "%s is exported, so a child process sees what the per-env config set",
    (key) => {
      tagAc(AC_MISMATCH_FATAL);
      expect(DEPLOY_CONFIG).toMatch(
        new RegExp(`if \\[ -n "\\$\\{${key}\\+set\\}" \\]; then\\s*\\n\\s*export ${key}`),
      );
    },
  );

  it("the export keeps set-vs-unset semantics — an env that never sets it stays unchanged", () => {
    tagAc(AC_MISMATCH_FATAL);
    // An UNGUARDED `export DB_POOL_MAX` would export an empty value on int, which deploy.sh's
    // ${DB_POOL_MAX+...} would then treat as SET and push to Cloud Run — blanking a live pool.
    // So there must be exactly one occurrence, and the assertion above proves that one is guarded.
    const occurrences = DEPLOY_CONFIG.match(/export DB_POOL_MAX/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

// ── DELIBERATELY UNTAGGED ─────────────────────────────────────────────────────
//
// These tests carry no tagAc, and that is the point rather than an oversight.
//
// planEmissions decides which criteria a run may speak for. The criteria it speaks for
// — ac-14, ac-9, ac-1, ac-6, ac-2 — assert things about a REAL prod deploy. Tagging
// these unit tests to them would turn those criteria green from a laptop, which is
// exactly the substitution the whole guard exists to prevent: a check that reads true
// against the artifact it inspects while being false about the world.
//
// So the logic is tested here, and the criteria are moved only by a deploy that
// actually observed prod. What this file owes them is that the gate is honest.
describe("spec-518: planEmissions refuses to speak for a deploy that did not happen", () => {
  const base = { env: "prod", observed: true, fatal: false, connectionsInUse: 27, usable: 197 } as const;

  it("the pre-flight emits nothing — nothing has been applied yet", () => {
    expect(planEmissions({ ...base, mode: "plan" })).toEqual([]);
  });

  it("int emits nothing, even on a clean run", () => {
    // ac-14, ac-1 and ac-6 name prod; int's config is deliberately unset (t-4) so its
    // comparison is vacuous. An int deploy turning a prod-shaped criterion green would
    // be the lie this Spec exists to stop.
    expect(planEmissions({ ...base, mode: "applied", env: "int" })).toEqual([]);
  });

  it("a run that could not READ emits nothing — not even a failure", () => {
    // "We didn't look" and "we looked and it was wrong" are different facts, and only
    // the second is a verdict.
    expect(planEmissions({ ...base, mode: "applied", observed: false })).toEqual([]);
    expect(planEmissions({ ...base, mode: "applied", observed: false, fatal: true })).toEqual([]);
  });

  it("a clean prod run records all five as passing", () => {
    const emissions = planEmissions({ ...base, mode: "applied" });
    expect(emissions.map((e) => e.ac_uid.split("/").pop())).toEqual([
      "ac-14",
      "ac-9",
      "ac-1",
      "ac-6",
      "ac-2",
    ]);
    expect(emissions.every((e) => e.status === "pass")).toBe(true);
    expect(emissions.every((e) => e.ac_uid.startsWith(`${SPEC}/`))).toBe(true);
  });

  it("a failing prod run records failures — the signal that matters", () => {
    const emissions = planEmissions({ ...base, mode: "applied", fatal: true });
    const byAc = Object.fromEntries(emissions.map((e) => [e.ac_uid.split("/").pop(), e.status]));
    expect(byAc["ac-14"]).toBe("fail");
    expect(byAc["ac-1"]).toBe("fail");
  });

  it("ac-2 is a separate observation, not the verdict restated", () => {
    // The configuration can match perfectly while the instance is out of connections;
    // those are different questions, so they get different answers.
    const overCeiling = planEmissions({ ...base, mode: "applied", connectionsInUse: 197 });
    const byAc = Object.fromEntries(overCeiling.map((e) => [e.ac_uid.split("/").pop(), e.status]));
    expect(byAc["ac-2"]).toBe("fail");
    expect(byAc["ac-14"]).toBe("pass");
  });

  it("an unreadable pg_stat_activity drops ac-2 rather than guessing", () => {
    const emissions = planEmissions({
      mode: "applied",
      env: "prod",
      observed: true,
      fatal: false,
    });
    expect(emissions.map((e) => e.ac_uid.split("/").pop())).not.toContain("ac-2");
    expect(emissions).toHaveLength(4);
  });
});

describe("spec-518 ac-16: the readers parse the REVISION, because the template is intent", () => {
  // `gcloud run services describe` returns spec.template — what the next revision WOULD get.
  // Reading it would ship a second source-reader with extra steps. The applied truth is on
  // the revision that traffic is on. These fixtures are the real shapes, trimmed.
  const REVISION_JSON = {
    metadata: {
      name: "memex-api-00130-hgj",
      annotations: {
        "autoscaling.knative.dev/maxScale": "8",
        "autoscaling.knative.dev/minScale": "1",
        "run.googleapis.com/cloudsql-instances": "memex-ai-prod:us-east4:memex-prod",
      },
    },
    spec: {
      containers: [{ env: [{ name: "NODE_ENV", value: "production" }, { name: "DB_POOL_MAX", value: "4" }] }],
    },
  };

  it("reads maxScale / minScale / DB_POOL_MAX off the revision", () => {
    tagAc(AC_APPLIED_BUDGET);
    const parsed = parseRevisionScaling(REVISION_JSON);
    expect(parsed).toMatchObject({
      revision: "memex-api-00130-hgj",
      maxInstances: 8,
      minInstances: 1,
      dbPoolMax: 4,
      cloudSqlInstances: ["memex-ai-prod:us-east4:memex-prod"],
    });
  });

  it("an absent minScale annotation reads as 0, and an absent DB_POOL_MAX as undefined", () => {
    tagAc(AC_APPLIED_BUDGET);
    // Cloud Run omits the annotation entirely at minScale 0 — that is int's live shape. The
    // two absences mean different things and must not collapse: 0 is a value, undefined is
    // "the code default applies", which is what the budget has to substitute.
    const parsed = parseRevisionScaling({
      metadata: {
        name: "memex-api-00623-zpb",
        annotations: {
          "autoscaling.knative.dev/maxScale": "3",
          "run.googleapis.com/cloudsql-instances": "memex-ai-int:us-east4:memex-mvp",
        },
      },
      spec: { containers: [{ env: [{ name: "NODE_ENV", value: "production" }] }] },
    });
    expect(parsed.minInstances).toBe(0);
    expect(parsed.dbPoolMax).toBeUndefined();
  });

  it("resolves which revision traffic is actually on", () => {
    tagAc(AC_APPLIED_BUDGET);
    const parsed = parseServingRevisions({
      status: {
        latestReadyRevisionName: "memex-api-00130-hgj",
        traffic: [{ latestRevision: true, percent: 100, revisionName: "memex-api-00130-hgj" }],
      },
    });
    expect(parsed).toEqual({ serving: ["memex-api-00130-hgj"], latestReady: "memex-api-00130-hgj" });
  });

  it("a split rollout reports EVERY revision carrying traffic", () => {
    tagAc(AC_APPLIED_BUDGET);
    const parsed = parseServingRevisions({
      status: {
        latestReadyRevisionName: "memex-api-00131-xyz",
        traffic: [
          { percent: 50, revisionName: "memex-api-00130-hgj" },
          { percent: 50, revisionName: "memex-api-00131-xyz" },
          { percent: 0, revisionName: "memex-api-00129-old" },
        ],
      },
    });
    // A 0% entry is not serving; both 50% entries are, and during a split BOTH hold pools.
    expect(parsed.serving).toEqual(["memex-api-00130-hgj", "memex-api-00131-xyz"]);
  });
});
