#!/usr/bin/env tsx
/**
 * spec-518 t-7 — assert the scaling a deploy ACTUALLY applied, read back from live Cloud Run.
 *
 * Every other check on this Spec reads the source. `deploy.sh`'s flag syntax, `deploy-config.sh`'s
 * exports, the budget arithmetic in a regression test — all three were green throughout BOTH of
 * this Spec's incidents, because none of them can observe that CI never ran the exporting branch.
 * They read intent; the defect lives in the outcome. This is the only check that reads the outcome.
 *
 * It lives in the deploy rather than in the HTTP smoke suite because it needs gcloud and a
 * database connection — the smoke only knows a base URL. Which is also why it had never been
 * written: the deploy is the one place no test runs.
 *
 * ── Two invocations, both inside deploy.sh's cloud-sql-proxy window ──
 *
 *   --mode=plan      BEFORE the cutover. Refuses an ABSENT scaling value on prod (a missing
 *                    variable becoming a live `${VAR:-default}` is the trap), and checks the
 *                    budget on the values this deploy is ABOUT to apply. Cheap save: it aborts
 *                    before prod is touched.
 *
 *   --mode=applied   AFTER the cutover. Reads the revision traffic is actually on, compares every
 *                    value config set against what that revision carries, and re-checks the budget
 *                    on the numbers IN FORCE. Necessarily after: what was applied cannot be known
 *                    before applying it. Pair a failure here with the rollback path (a
 *                    workflow_dispatch redeploy of the previous SHA).
 *
 * ── What it counts ──
 *
 * `src/deploy/scaling-budget.ts` holds the arithmetic and the comparison, pure and unit-tested
 * (ac-16 / ac-19 / ac-20). Read the invariant's derivation there. In short: every Cloud Run
 * service attached to this Cloud SQL instance, each at `2 × maxInstances × (pool + 1)`, plus an
 * admin reserve, against `max_connections − superuser_reserved − reserved` READ FROM POSTGRES.
 * Not from `gcloud sql describe`: prod ran a week on a recorded ceiling sized for a machine that
 * no longer existed (dec-2).
 *
 * ── Posture (dec-5) ──
 *
 * A budget violation aborts on prod and warns on int, because int violates the corrected
 * invariant today (`2 × 3 × (5+1) = 36` against 22 usable) and survives it — int's load never
 * extends the pools. A MISMATCH aborts everywhere: a value set in config that did not reach the
 * running revision is a plumbing defect with no environmental excuse, and int is exactly where it
 * must be caught, since int deploys first.
 *
 * A read that FAILS is treated the same way as a violation — fatal on prod, a warning elsewhere.
 * A guard that cannot read must not report success; "nobody checked" is what this exists to end.
 */

import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  CLOUD_RUN_DEFAULT_MAX_INSTANCES,
  SCALING_KEYS,
  type Emission,
  type ScalingKey,
  type ServiceObservation,
  comparePlan,
  computeBudget,
  decideOutcome,
  formatBudgetReport,
  declarationWarnings,
  undeclaredServices,
  DECLARATION_VAR,
  isProd,
  parseRevisionScaling,
  parseServingRevisions,
  planEmissions,
  usableConnections,
} from "../src/deploy/scaling-budget.js";

type Mode = "plan" | "applied";

const mode: Mode = process.argv.includes("--mode=applied") ? "applied" : "plan";

const ENV = process.env.ENV ?? "int";
const SERVICE = process.env.SERVICE ?? "memex-api";
const REGION = process.env.REGION ?? "us-east4";
const PROJECT = process.env.GCP_PROJECT ?? "";
const INSTANCE_CONN = process.env.CLOUD_SQL_INSTANCE_CONN ?? "";
// deploy.sh's proxy URL. DATABASE_URL is the fallback so the script is runnable by hand.
const DB_URL = process.env.DB_URL ?? process.env.DATABASE_URL ?? "";

/** What config asked for — absent stays absent, which is a fact the comparison needs. */
const intended: Partial<Record<ScalingKey, string | undefined>> = {
  MAX_INSTANCES: process.env.MAX_INSTANCES,
  MIN_INSTANCES: process.env.MIN_INSTANCES,
  DB_POOL_MAX: process.env.DB_POOL_MAX,
};

const readFailures: string[] = [];

function gcloudJson(args: string[]): unknown {
  const out = execFileSync("gcloud", [...args, "--format=json"], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Ceiling and current usage from Postgres — the values in force, not the values recorded.
 *
 * `inUse` is what ac-2 asks for ("verified in pg_stat_activity"), read at the one moment
 * it is most worth reading: immediately after a cutover, when both revisions may still
 * hold pools. It is an observation, not a bound — see scaling-budget.ts on why a usage
 * sample cannot stand in for the budget.
 */
async function readDbFacts(): Promise<{ usable?: number; inUse?: number }> {
  if (!DB_URL) {
    readFailures.push("no DB_URL — cannot read the connection ceiling from Postgres");
    return {};
  }
  // max: 1 and a short timeout: this runs during a deploy, against the ceiling it is measuring.
  const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    const rows = await sql<{ name: string; setting: string }[]>`
      select name, setting from pg_settings
      where name in ('max_connections', 'superuser_reserved_connections', 'reserved_connections')
    `;
    const get = (n: string) => Number(rows.find((r) => r.name === n)?.setting ?? Number.NaN);
    const maxConnections = get("max_connections");
    if (!Number.isFinite(maxConnections)) {
      readFailures.push("pg_settings returned no max_connections");
      return {};
    }
    const superuserReserved = get("superuser_reserved_connections");
    const reserved = get("reserved_connections");
    const usable = usableConnections({
      maxConnections,
      superuserReserved: Number.isFinite(superuserReserved) ? superuserReserved : 0,
      // reserved_connections is PG16+; an older server simply has no such row.
      reserved: Number.isFinite(reserved) ? reserved : 0,
    });
    console.log(
      `  ceiling (read from Postgres): max_connections ${maxConnections} − superuser ${superuserReserved || 0} ` +
        `− reserved ${Number.isFinite(reserved) ? reserved : 0} = ${usable} usable`,
    );

    // ac-2's observation. Non-fatal on its own: a usage sample is not the budget, and
    // the budget is checked separately against the configured bound.
    let inUse: number | undefined;
    try {
      const [row] = await sql<{ count: string }[]>`select count(*)::text as count from pg_stat_activity`;
      inUse = Number(row?.count);
      if (!Number.isFinite(inUse)) inUse = undefined;
      else console.log(`  in use right now (pg_stat_activity): ${inUse} of ${usable} usable`);
    } catch {
      console.log("  ⚠ could not read pg_stat_activity — the usage observation is skipped");
    }

    return { usable, inUse };
  } catch (err) {
    readFailures.push(`could not read the ceiling from Postgres: ${(err as Error).message}`);
    return {};
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Record this run's verdict against the criteria only a deploy can witness.
 *
 * Strictly telemetry: it runs AFTER the verdict, never instead of it, and it cannot
 * change the exit code. A failed emission costs an AC its freshness until the next
 * deploy — never a deploy. No retries: a 429 here means the server is shedding load,
 * and this runs at a cutover, which is precisely the wrong moment to insist.
 */
async function emitDeployObservations(emissions: Emission[], revision?: string): Promise<void> {
  if (emissions.length === 0) return;
  if (/^(false|0|no|off)$/i.test(process.env.MEMEX_EMIT ?? "")) return;

  const key = process.env.MEMEX_EMIT_KEY;
  if (!key) {
    console.log("  ⚠ MEMEX_EMIT_KEY unset — deploy-observed ACs keep their previous state");
    return;
  }

  const testIdentifier = `packages/server/scripts/verify-scaling-budget.ts::${ENV}::applied`;
  const body = {
    events: emissions.map((e) => ({
      ...e,
      test_identifier: testIdentifier,
      duration_ms: 0,
      metadata: {
        service: SERVICE,
        revision: revision ?? "",
        source: "deploy-guard",
      },
    })),
  };

  try {
    const res = await fetch("https://memex.ai/api/test-events/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`  ⚠ AC emission returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    console.log(
      `  ✓ recorded ${emissions.length} deploy-observed acceptance criteria ` +
        `(${emissions.map((e) => `${e.ac_uid.split("/").pop()}=${e.status}`).join(" ")})`,
    );
  } catch (err) {
    // Swallow. Emission must never be able to break a deploy.
    console.log(`  ⚠ AC emission failed (non-fatal): ${(err as Error).message}`);
  }
}

type LiveService = {
  observation: ServiceObservation;
  serving: string[];
  latestReady?: string;
};

/**
 * Every Cloud Run service in this region whose SERVING revision is attached to our Cloud SQL
 * instance. Enumerated from gcloud rather than from a list in this repo on purpose: `backstage`
 * has no deploy definition here, and the term that gets forgotten is the one nobody wrote down.
 */
function readLiveServices(): LiveService[] {
  const listed = gcloudJson(["run", "services", "list", "--region", REGION, "--project", PROJECT]);
  const services = Array.isArray(listed) ? listed : [];
  const live: LiveService[] = [];

  for (const svc of services) {
    const name = (svc as { metadata?: { name?: string } })?.metadata?.name;
    if (!name) continue;
    const { serving, latestReady } = parseServingRevisions(svc);
    const revisionName = serving[0] ?? latestReady;
    if (!revisionName) continue;

    const revision = parseRevisionScaling(
      gcloudJson(["run", "revisions", "describe", revisionName, "--region", REGION, "--project", PROJECT]),
    );
    if (!revision.cloudSqlInstances.includes(INSTANCE_CONN)) continue;

    if (revision.maxInstances === undefined) {
      // Not a value anyone chose — Cloud Run's own default. On a shared database that deserves
      // to be counted at its real ceiling and said out loud.
      console.log(
        `  ⚠ ${name} sets no maxScale — counting Cloud Run's default of ${CLOUD_RUN_DEFAULT_MAX_INSTANCES}`,
      );
    }

    live.push({
      serving,
      latestReady,
      observation: {
        service: name,
        revision: revisionName,
        maxInstances: revision.maxInstances ?? CLOUD_RUN_DEFAULT_MAX_INSTANCES,
        minInstances: revision.minInstances,
        dbPoolMax: revision.dbPoolMax,
        // The service's own COMPLETE per-instance declaration, when it publishes one
        // (spec-525 t-15). Read beside dbPoolMax and never compared to it: the coherent
        // relation differs per service, which is why declarations exist at all.
        declaredPerInstance: revision.declaredPerInstance,
        // Only our own service's pool default is knowable from this codebase; anything else is
        // counted at the postgres-js default, because over-counting fails safe. Retired with
        // the inference branches when phase B flips.
        ownCode: name === SERVICE,
      },
    });
  }
  return live;
}

function requireEnv(): void {
  if (!PROJECT) readFailures.push("GCP_PROJECT is not set");
  if (!INSTANCE_CONN) readFailures.push("CLOUD_SQL_INSTANCE_CONN is not set");
}

async function main(): Promise<void> {
  console.log("");
  console.log(
    `── spec-518 t-7: connection-budget guard (mode=${mode}, ENV=${ENV}, service=${SERVICE}) ──`,
  );

  requireEnv();
  const { usable, inUse } = await readDbFacts();

  let live: LiveService[] = [];
  if (readFailures.length === 0) {
    try {
      live = readLiveServices();
    } catch (err) {
      readFailures.push(`could not read live Cloud Run configuration: ${(err as Error).message}`);
    }
  }

  const self = live.find((s) => s.observation.service === SERVICE);

  // ── The comparison (applied mode only — before the cutover there is nothing new to compare) ──
  let comparison;
  let revision;
  if (mode === "applied") {
    if (!self) {
      readFailures.push(`${SERVICE} was not found among the services attached to ${INSTANCE_CONN}`);
    } else {
      const applied: Partial<Record<ScalingKey, string | undefined>> = {
        MAX_INSTANCES: String(self.observation.maxInstances),
        MIN_INSTANCES: String(self.observation.minInstances ?? 0),
        DB_POOL_MAX:
          self.observation.dbPoolMax === undefined ? undefined : String(self.observation.dbPoolMax),
      };
      comparison = comparePlan({ env: ENV, intended, applied });
      revision = self.latestReady
        ? { serving: self.serving, expectedLatestReady: self.latestReady }
        : undefined;

      console.log("  applied on the serving revision:");
      console.log(`    revision: ${self.observation.revision} (traffic: ${self.serving.join(", ") || "none"})`);
      for (const key of SCALING_KEYS) {
        console.log(`    ${key}: config ${intended[key] ?? "(unset)"} → applied ${applied[key] ?? "(absent)"}`);
      }
    }
  } else if (isProd(ENV)) {
    // Pre-cutover, prod's only checkable claim is that it expressed every value explicitly.
    comparison = comparePlan({
      env: ENV,
      intended,
      // Nothing to compare against yet, so mirror the intent: this pass exists to catch
      // ABSENCE, and comparing intent to itself keeps that the only thing it can report.
      applied: intended,
    });
  }

  // ── The budget ──
  let budget;
  if (usable !== undefined && live.length > 0) {
    const services = live.map((s) => {
      if (mode === "plan" && s.observation.service === SERVICE) {
        // This deploy is about to change our own numbers — budget the ones it will apply.
        const wantMax = Number(intended.MAX_INSTANCES);
        const wantPool = Number(intended.DB_POOL_MAX);
        return {
          ...s.observation,
          maxInstances: Number.isFinite(wantMax) ? wantMax : s.observation.maxInstances,
          dbPoolMax: Number.isFinite(wantPool) ? wantPool : undefined,
        };
      }
      return s.observation;
    });
    budget = computeBudget({ services, usable });
    console.log(`  budget (${mode === "plan" ? "values about to be applied" : "values in force"}):`);
    for (const line of formatBudgetReport(budget)) console.log(line);

    // PHASE A (spec-525 t-15): name every service whose figure was INFERRED rather than
    // read. Its audience is not this deploy's reader — it is whoever decides when phase B
    // can be switched on: FLIP IT WHEN THIS GOES QUIET. Without it, that call rests on
    // memory, and a near-miss on the contract string prints the pre-declaration line
    // unchanged, which reads as success.
    const undeclared = declarationWarnings(budget);
    if (undeclared.length > 0) {
      console.log("");
      console.log("  declarations (spec-525 t-15) — inferred, not read:");
      for (const line of undeclared) console.log(`  ${line}`);
    } else {
      console.log("");
      console.log(
        `  ✓ every service declares ${DECLARATION_VAR} — phase B's switch ` +
          `(REQUIRE_CONNECTION_DECLARATIONS=1) can be turned on`,
      );
    }
  }

  const outcome = decideOutcome({ env: ENV, budget, comparison, revision });

  // A read failure is "nobody checked", which is the condition this guard exists to end.
  const failures = [...outcome.failures];

  const warnings = [...outcome.warnings];
  // PHASE B — OFF BY DEFAULT, and that is not timidity. Every service is undeclared the day
  // this lands, so an on-by-default refusal would abort memex-api's own deploys: the guard
  // working exactly as designed and stopping all work. Turn it on when phase A's list above
  // is empty.
  //
  // TWO CONDITIONS on the refusal, both learned by asking what it would actually do:
  //
  // 1. `plan` MODE ONLY. This script runs twice — before the deploy (`plan`) and after the
  //    cutover (`applied`). In `plan` a refusal PREVENTS the deploy. In `applied` traffic
  //    has already moved, so it can only paint a successful deploy red after the fact, with
  //    no rollback — and a red mark on a deploy that worked trains people to ignore red
  //    marks. Post-cutover it is a warning, which is all it can honestly be.
  //
  // 2. FATAL ON PROD, WARNING ELSEWHERE — the posture spec-518 dec-5 already set for a blown
  //    budget, followed here rather than diverged from in silence. The sequence still
  //    protects prod: int warns first, and prod's refusal lands in `plan`, BEFORE any
  //    revision is created. The cost is that a missing declaration is discovered at prod's
  //    plan step rather than on int, and that is the trade dec-5 already made.
  if (budget) {
    const refusals = undeclaredServices(budget, {
      requireDeclarations: process.env.REQUIRE_CONNECTION_DECLARATIONS === "1",
    });
    for (const refusal of refusals) {
      if (mode === "plan" && isProd(ENV)) failures.push(refusal);
      else warnings.push(`${refusal}\n      (non-fatal in mode=${mode} on ${ENV})`);
    }
  }
  for (const f of readFailures) {
    if (isProd(ENV)) failures.push(`guard could not verify: ${f}`);
    else warnings.push(`guard could not verify: ${f} — non-fatal on ${ENV}`);
  }

  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const f of failures) console.error(`  ✗ ${f}`);

  // Record the verdict against the criteria only a deploy can witness — AFTER the
  // verdict is final, and never in place of it. `observed` is the honest gate: a run
  // that could not read emits nothing, because "we didn't look" is not a result.
  await emitDeployObservations(
    planEmissions({
      mode,
      env: ENV,
      observed: readFailures.length === 0 && self !== undefined,
      fatal: failures.length > 0,
      connectionsInUse: inUse,
      usable,
    }),
    self?.observation.revision,
  );

  if (failures.length > 0) {
    console.error("");
    console.error(
      `  ABORTING (${mode}): the applied configuration does not match the plan, or does not fit the ` +
        `connection ceiling. Roll back by redeploying the previous SHA (workflow_dispatch) if this ` +
        `ran post-cutover.`,
    );
    process.exit(1);
  }

  // The summary must never claim more than the findings support. A line reading "fits the
  // ceiling" above a warning saying it does not is the defect class this whole Spec documents.
  if (warnings.length > 0) {
    console.log(
      `  ✓ nothing fatal for ENV=${ENV}, but ${warnings.length} warning${warnings.length > 1 ? "s" : ""} above ` +
        `— this configuration would ABORT on prod`,
    );
  } else {
    console.log(
      `  ✓ ${mode === "plan" ? "plan is explicit and fits the ceiling" : "applied configuration matches the plan and fits the ceiling"}`,
    );
  }
  console.log("");
}

main().catch((err) => {
  // Never a silent pass: an unexpected throw is itself an unverified deploy. On prod that is
  // fatal. Off prod it must not block the deploy (dec-5's posture), but it must still be
  // impossible to mistake for a clean run in the log — int is where the guard is exercised most,
  // so a guard that crashed on every int deploy while printing nothing loud would be invisible
  // exactly where it is watched.
  console.error(`  ✗ scaling-budget guard CRASHED — nothing was verified: ${(err as Error).stack ?? err}`);
  if (isProd(ENV)) process.exit(1);
  console.error(
    `  ⚠ continuing anyway because ENV=${ENV} is not prod (spec-518 dec-5) — but this deploy went ` +
      `out UNVERIFIED, which is the condition t-7 exists to end. Fix the crash before the next prod release.`,
  );
  process.exit(0);
});
