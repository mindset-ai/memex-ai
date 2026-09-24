// spec-518 t-7 — the connection budget, computed over the values a deploy APPLIED.
//
// Every other check on this Spec reads the SOURCE: deploy.sh's flag syntax, deploy-config.sh's
// exports, the intended arithmetic in a regression test. All of them were green throughout the
// 2026-08-03 and 2026-08-11 incidents, because none of them can observe what actually reached
// the running revision. This module is the arithmetic and the comparison for a guard that reads
// the outcome instead — `scripts/verify-scaling-budget.ts` supplies the live values.
//
// It is deliberately PURE: no gcloud, no database, no process.exit. That is what makes the
// guard's own logic unit-testable (spec-518 ac-16 / ac-19 / ac-20), and it is why the guard is
// not written in bash — issue-5 is what a shell guard invites.
//
// ── The invariant, and why the obvious form of it is unsound ──
//
// deploy.sh has carried this since spec-518's config path landed:
//
//     MAX_INSTANCES × (DB_POOL_MAX + 1 relay LISTEN)  <  usable connections
//
// It is not wrong; it is a sum with terms missing (spec-332 dec-3 reached the same conclusion on
// 2026-06-23). Four investigations on this Spec each contributed one:
//
//   issue-4  a cutover runs the draining AND starting revision together, and a draining instance
//            holds its pool while serving nothing → the peak is 2 × maxInstances
//   issue-2  `backstage` shares the same Cloud SQL instance and appears in no arithmetic
//   issue-3  the invariant is a COMMENT — nothing asserts it, nothing aborts
//   —        admin / migration sessions, including the deploy's own cloud-sql-proxy
//
// So what this module computes is:
//
//     Σ over every service on the instance  of  2 × maxInstances × (poolMax + 1)
//       + an admin reserve                                        ≤  usable
//
// The peak matters more than the steady state for one uncomfortable reason: **a deploy is the
// one moment the budget must hold twice over, and it is also the only moment anyone changes the
// configuration.** A guard that checks steady state passes on exactly the configuration that
// failed on 2026-08-11.

/**
 * The spec-156 bus-relay `LISTEN` connection: one persistent connection per Cloud Run instance,
 * opened with `{ max: 1 }` and no idle timeout, deliberately — a LISTEN socket must stay open to
 * receive NOTIFYs. It sits OUTSIDE the pool, which is why the per-instance footprint is
 * `poolMax + 1` and not `poolMax` (db/connection.ts).
 */
export const RELAY_LISTEN_PER_INSTANCE = 1;

/**
 * During a revision cutover BOTH revisions hold instances: the new one serving, the old one
 * draining while still holding its pool. Request count does not bound instance count — on
 * 2026-08-11 the draining revision served 3 requests and the incoming one 997, and the
 * connections were exhausted anyway.
 */
export const CUTOVER_REVISION_FACTOR = 2;

/**
 * What an UNDECLARED service is counted at: the postgres-js default of `max: 10`, whoever
 * runs it — ours or anyone else's.
 *
 * Kept after phase B (spec-525 t-15) for one reason, stated so it is not mistaken for a
 * stationary inference: an undeclared service is REFUSED, but the budget report still has
 * to print a line for it, and the refusal message names the figure used. Over-counting is
 * the safe direction for that line. It is only load-bearing for the deploy's verdict when
 * the escape hatch (`REQUIRE_CONNECTION_DECLARATIONS=0`) is in use — then it is the
 * fail-safe count for the hours the hatch is open.
 *
 * Retired with phase B, and why both went together: `applied` read a per-POOL
 * `DB_POOL_MAX` as a whole-instance footprint (backstage opens two pools sized by one
 * variable, so it under-counted by up to 2x), and `our-code-default` read the pool DEFAULT
 * where prod's pool is 4 by env override — masked only by `applied` winning. Removing one
 * alone would have promoted the other to being the lying branch.
 */
export const FOREIGN_SERVICE_DEFAULT_POOL = 10;

/**
 * Slots kept for the consumers no service annotation describes: the deploy's own
 * cloud-sql-proxy, hand-run migrations, `cloudsqladmin`, and an operator's psql session. Prod
 * measured 4 `cloudsqladmin` + 1 psql at rest on 2026-08-11, so 5 is the observed figure rather
 * than a guess. It is a reserve, not a cap — nothing enforces it on those sessions.
 */
export const ADMIN_SESSION_RESERVE = 5;

/**
 * The ONE string every service and this guard must match, byte for byte.
 *
 * Settled by `memex-backstage` spec-19 dec-5, and named here so the guard and its warnings
 * cannot drift from each other. No `POOL` token, because it states both facts the guard
 * needs: it counts CONNECTIONS, and it counts them PER INSTANCE. `DB_POOL_TOTAL` was
 * rejected — a declared figure is every pool summed PLUS any long-lived connection outside
 * a pool, so that name would be true only by coincidence.
 *
 * A near-miss on this string is why phase A warns rather than staying silent: write
 * `DB_CONNECTION_PER_INSTANCE` (singular) and the guard finds nothing, falls back, and
 * prints the line it printed before declarations existed. Not a silent failure — a SUCCESS
 * SIGNAL, on the one string that IS the contract (spec-525 t-15).
 */
/**
 * How to UNBLOCK a deploy this guard refused — carried in the refusal message itself.
 *
 * Not documentation-adjacent politeness. This refusal can be triggered by a change nobody
 * on this repo made: the guard enumerates every Cloud Run service attached to the same
 * Cloud SQL instance (from `gcloud`, deliberately not from a list here), so a NEW service
 * someone else deploys, or another team renaming their own variable, stops OUR deploys —
 * including a hotfix. The remedy is one variable, and a remedy that takes one word but is
 * known to nobody costs hours at 3am. So the message states it rather than pointing at a
 * standard somebody has to go and find.
 */
export const UNBLOCK_HINT =
  "TO UNBLOCK NOW: set the GitHub environment variable REQUIRE_CONNECTION_DECLARATIONS=0 " +
  "and re-run the deploy. That counts undeclared services at the foreign default instead " +
  "of refusing them, which over-counts (the safe direction) — then restore the declaration " +
  "and delete the variable, because while it is set nothing stops the next one going missing.";

export const DECLARATION_VAR = "DB_CONNECTIONS_PER_INSTANCE";

/**
 * Cloud Run's own default when a service carries no `maxScale` annotation. Not a value anyone
 * chose — which is exactly why a service on a shared database that never set one deserves to be
 * counted at 100 and shouted about.
 */
export const CLOUD_RUN_DEFAULT_MAX_INSTANCES = 100;

/** The scaling values dec-3 pins per environment, and therefore the ones a deploy must apply. */
export const SCALING_KEYS = ["MAX_INSTANCES", "MIN_INSTANCES", "DB_POOL_MAX"] as const;
export type ScalingKey = (typeof SCALING_KEYS)[number];

/** `prod` is the only environment where a budget violation stops a deploy (dec-5). */
export function isProd(env: string): boolean {
  return env === "prod";
}

// ── Ceiling ───────────────────────────────────────────────────────────────────

export type CeilingSettings = {
  maxConnections: number;
  /** `superuser_reserved_connections` — 3 on both of ours. */
  superuserReserved?: number;
  /** `reserved_connections` — PG16+, 0 today. Subtracted anyway, or the ceiling drifts the day it isn't. */
  reserved?: number;
};

/**
 * Connections actually available to the runtime role.
 *
 * Read these from Postgres (`pg_settings`), never from `gcloud sql describe`'s recorded flags:
 * dec-2's thesis is that the value recorded is not the value in force — prod ran a week on a
 * `max_connections` sized for a machine that no longer existed.
 */
export function usableConnections({
  maxConnections,
  superuserReserved = 0,
  reserved = 0,
}: CeilingSettings): number {
  return Math.max(0, maxConnections - superuserReserved - reserved);
}

// ── Per-service demand ────────────────────────────────────────────────────────

export type ServiceObservation = {
  service: string;
  revision?: string;
  maxInstances: number;
  minInstances?: number;
  /**
   * The runtime pool knob, carried ONLY for the applied-vs-intended comparison. **The budget
   * never reads it** (spec-525 t-15 phase B): it sizes one pool, and a service's footprint is
   * whatever it declares — one name meaning two things was the defect.
   */
  dbPoolMax?: number;
  /**
   * The service's own declaration of its COMPLETE per-instance footprint, from
   * {@link DECLARATION_VAR} — every pool the instance opens, plus any long-lived connection
   * outside a pool. When present it is used AS IS: nothing is added on top, because there is
   * nothing left for the guard to infer.
   */
  declaredPerInstance?: number;
};

/**
 * Where a per-instance figure came from. `declared` is a READING; `foreign-default` is the
 * over-count printed for a service that declares nothing, which phase B refuses.
 */
export type PoolSource = "declared" | "foreign-default";

export type ServiceTerm = {
  service: string;
  revision?: string;
  maxInstances: number;
  /**
   * The per-POOL figure, when one was inferred. **Absent for a declared service**, because a
   * declaration is a whole-instance total and calling it a pool max would be the
   * counted-vs-real confusion this task removes, wearing a different field name.
   */
  poolMax?: number;
  poolSource: PoolSource;
  /** The whole per-instance footprint the budget counts. */
  perInstance: number;
  /**
   * Whether {@link RELAY_LISTEN_PER_INSTANCE} was added on top. False for a declaration —
   * and load-bearing rather than decorative, because `formatBudgetReport` printed
   * `+ 1 relay LISTEN` on every line regardless, which is a lie for a complete declaration.
   */
  relayCounted: boolean;
  /** One revision at full scale. */
  steady: number;
  /** Both revisions at full scale — what a cutover can actually demand. */
  peak: number;
};

export function serviceTerm(obs: ServiceObservation): ServiceTerm {
  const declared = obs.declaredPerInstance;
  const hasDeclaration = declared !== undefined && Number.isFinite(declared) && declared >= 1;

  // A DECLARATION IS COMPLETE, so the guard adds nothing to it — not the relay LISTEN, not
  // a second pool it cannot see. The `+1` below belongs to what the guard COMPUTES, never
  // to what a service OPENS: backstage has no relay LISTEN at all (its UI polls), and it
  // opens TWO pools the guard has no way to count. That is the whole reason declarations
  // exist, and adding to one would put the inference back (spec-525 t-15, ac-27).
  //
  // No coherence check against `dbPoolMax`, deliberately, even when both are present: the
  // coherent relation differs per service — memex-api's total is pool + relay (5 = 4+1),
  // backstage's is 2 x pool — and the guard cannot know which form applies. A check would
  // be the guessing this removes, wearing an equals sign.
  //
  // An undeclared service gets the foreign default whatever DB_POOL_MAX says — reading it
  // was the `applied` branch, retired in phase B.
  const inferred = hasDeclaration
    ? undefined
    : { poolMax: FOREIGN_SERVICE_DEFAULT_POOL, poolSource: "foreign-default" as const };
  const perInstance = inferred
    ? inferred.poolMax + RELAY_LISTEN_PER_INSTANCE
    : Math.floor(declared as number);
  const steady = obs.maxInstances * perInstance;

  const base = {
    service: obs.service,
    revision: obs.revision,
    maxInstances: obs.maxInstances,
    perInstance,
    steady,
    peak: steady * CUTOVER_REVISION_FACTOR,
  };

  return inferred
    ? { ...base, ...inferred, relayCounted: true }
    : { ...base, poolSource: "declared" as const, relayCounted: false };
}

/**
 * Every service that declares nothing — printed on every run, refused or not.
 *
 * Phase A's warning, kept after the flip: with the escape hatch open it is the only line
 * that still says what is being counted on a guess.
 */
export function declarationWarnings(budget: Budget): string[] {
  return budget.terms
    .filter((t) => t.poolSource !== "declared")
    .map(
      (t) =>
        `⚠ ${t.service}: no declaration found (expected ${DECLARATION_VAR}), ` +
        `counting ${t.poolSource} ${t.poolMax} + ${RELAY_LISTEN_PER_INSTANCE} relay LISTEN ` +
        `= ${t.perInstance} per instance`,
    );
}

/**
 * PHASE B — the same list, as refusals. **On by default** since 2026-09-24.
 *
 * It shipped off by default, because every service was undeclared the day it landed and a
 * refusal would have aborted memex-api's own deploys. The flip was made on evidence, not
 * memory: the guard run against prod printed every service `[declared]` and an empty
 * warning list. `allowUndeclared` is the escape hatch for a service someone ELSE broke —
 * never a steady state.
 */
export function undeclaredServices(
  budget: Budget,
  opts: { allowUndeclared?: boolean } = {},
): string[] {
  if (opts.allowUndeclared) return [];
  return budget.terms
    .filter((t) => t.poolSource !== "declared")
    .map(
      (t) =>
        `${t.service} declares no ${DECLARATION_VAR} — refusing rather than inferring. ` +
        `Used ${t.poolSource} (${t.poolMax} per pool) because that is all the revision ` +
        `published. Set ${DECLARATION_VAR} to the COMPLETE per-instance total: every pool ` +
        `the instance opens, plus any long-lived connection outside one.` +
        `\n      ${UNBLOCK_HINT}`,
    );
}

/**
 * Our own service as this deploy is ABOUT to run it — what `--mode=plan` must budget.
 *
 * Both figures come from the plan, never from the revision being replaced. Borrowing the
 * live declaration was a real defect: the declaration wins in {@link serviceTerm}, so a
 * deploy moving the pool was pre-flighted on the OLD footprint. An absent planned
 * declaration stays absent [per std-50] — a plan that declares nothing is about to ship an
 * undeclared revision, and it is refused like one. An absent `maxInstances` keeps the live
 * value, because unset IS int's chosen posture (spec-518 t-4).
 */
export function plannedObservation(
  live: ServiceObservation,
  intended: { maxInstances?: string; declaredPerInstance?: string },
): ServiceObservation {
  const wantMax = Number(intended.maxInstances);
  const wantDeclared = Number(intended.declaredPerInstance);
  return {
    ...live,
    maxInstances:
      intended.maxInstances !== undefined && intended.maxInstances !== "" && Number.isFinite(wantMax)
        ? wantMax
        : live.maxInstances,
    declaredPerInstance:
      intended.declaredPerInstance !== undefined && intended.declaredPerInstance !== "" && Number.isFinite(wantDeclared)
        ? wantDeclared
        : undefined,
  };
}

// ── The budget ────────────────────────────────────────────────────────────────

export type Budget = {
  /** One entry per service counted — the enumeration IS the point (see below). */
  terms: ServiceTerm[];
  adminReserve: number;
  steadyTotal: number;
  peakTotal: number;
  usable: number;
  /** Slots left at peak. Negative when the budget is blown. */
  headroom: number;
  withinBudget: boolean;
};

/**
 * Sum the demand of every service attached to the instance against the usable ceiling.
 *
 * The returned `terms` are not decoration. The defect here was never a wrong number — it was a
 * missing term, and a check that enumerates what it counted is the only kind that notices when a
 * new consumer appears.
 */
export function computeBudget({
  services,
  usable,
  adminReserve = ADMIN_SESSION_RESERVE,
}: {
  services: ServiceObservation[];
  usable: number;
  adminReserve?: number;
}): Budget {
  const terms = services.map(serviceTerm);
  const steadyTotal = terms.reduce((sum, t) => sum + t.steady, 0) + adminReserve;
  const peakTotal = terms.reduce((sum, t) => sum + t.peak, 0) + adminReserve;
  return {
    terms,
    adminReserve,
    steadyTotal,
    peakTotal,
    usable,
    headroom: usable - peakTotal,
    withinBudget: peakTotal <= usable,
  };
}

// ── Applied vs intended ───────────────────────────────────────────────────────

export type Mismatch = { key: ScalingKey; intended: string; applied: string | undefined };

export type PlanComparison = {
  /** Set in config, different (or absent) on the running revision. Fatal in every environment. */
  mismatches: Mismatch[];
  /** Absent from config where config must be explicit — prod only. */
  missing: ScalingKey[];
  /** Absent from config where absence is the chosen posture (int, t-4). Not a defect. */
  ignored: ScalingKey[];
};

function sameValue(intended: string, applied: string | undefined): boolean {
  if (applied === undefined) return false;
  const a = Number(intended);
  const b = Number(applied);
  if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  return intended === applied;
}

/**
 * Compare what config asked for against what the running revision carries.
 *
 * Two asymmetries, both deliberate:
 *
 * - **A set value that did not arrive is always a defect.** `DB_POOL_MAX=4` sat declared in the
 *   canonical secret while the serving revision carried something else — declared and in force
 *   are two different facts, and that gap is this Spec's whole lesson.
 * - **An absent value means different things per environment.** On prod, silence must not become
 *   a live configuration change: `${MAX_INSTANCES:-3}` turning a missing variable into an applied
 *   `3` is the trap, and it is the default rather than the arithmetic. On int, unset IS the chosen
 *   posture (t-4), so absence is recorded and not judged — the applied value still feeds the
 *   budget, it just isn't compared to an intent nobody expressed.
 */
export function comparePlan({
  env,
  intended,
  applied,
}: {
  env: string;
  intended: Partial<Record<ScalingKey, string | undefined>>;
  applied: Partial<Record<ScalingKey, string | undefined>>;
}): PlanComparison {
  const mustBeExplicit = isProd(env);
  const mismatches: Mismatch[] = [];
  const missing: ScalingKey[] = [];
  const ignored: ScalingKey[] = [];

  for (const key of SCALING_KEYS) {
    const want = intended[key];
    if (want === undefined || want === "") {
      (mustBeExplicit ? missing : ignored).push(key);
      continue;
    }
    const got = applied[key];
    if (!sameValue(want, got)) mismatches.push({ key, intended: want, applied: got });
  }

  return { mismatches, missing, ignored };
}

// ── The verdict ───────────────────────────────────────────────────────────────

export type RevisionTraffic = {
  /** Every revision carrying >0% of traffic. */
  serving: string[];
  /** The revision this deploy just created and expects to be serving alone. */
  expectedLatestReady: string;
};

export type Outcome = {
  fatal: boolean;
  failures: string[];
  warnings: string[];
};

/**
 * Turn observations into an exit code, per dec-5:
 *
 * | verdict                        | prod  | anything else |
 * |--------------------------------|-------|---------------|
 * | budget exceeded                | abort | warn          |
 * | applied ≠ intended             | abort | abort         |
 * | scaling value absent in config | abort | fine          |
 * | traffic not on the new revision| abort | abort         |
 *
 * The budget row is the only one with a per-env posture, and it has one because int violates the
 * corrected invariant today (`2 × 3 × (5+1) = 36` against 22 usable) and survives it — int's load
 * never extends the pools. The verdict is REPORTED identically in both; only the exit differs.
 * The other rows are plumbing defects with no environmental excuse, and int is precisely where
 * they must be caught, since int deploys first.
 */
export function decideOutcome({
  env,
  budget,
  comparison,
  revision,
}: {
  env: string;
  budget?: Budget;
  comparison?: PlanComparison;
  revision?: RevisionTraffic;
}): Outcome {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (revision) {
    const { serving, expectedLatestReady } = revision;
    if (serving.length !== 1 || serving[0] !== expectedLatestReady) {
      failures.push(
        `traffic is on ${serving.length ? serving.join(" + ") : "no revision"}, expected 100% on ${expectedLatestReady} — ` +
          `a rollout that reported success while traffic stayed put IS the applied-vs-intended gap`,
      );
    }
  }

  if (comparison) {
    for (const m of comparison.mismatches) {
      failures.push(
        `${m.key}: config says ${m.intended}, the serving revision has ${m.applied ?? "no value at all"} — ` +
          `a value declared and a value in force are two different facts`,
      );
    }
    for (const key of comparison.missing) {
      failures.push(
        `${key} is ABSENT from ${env} config — silence would become a live configuration change ` +
          `via the shell default, which is the trap rather than the arithmetic`,
      );
    }
  }

  if (budget && !budget.withinBudget) {
    const detail =
      `connection budget exceeded: peak ${budget.peakTotal} > ${budget.usable} usable ` +
      `(${budget.terms
        // Branches on `relayCounted` for the same reason `formatBudgetReport` does: a
        // declared service has no per-pool figure and no relay added, so `(poolMax+1)`
        // would print `(undefined+1)` — which it did, in a live int deploy log, until this
        // was the second reader of an optional field to be fixed rather than the first.
        .map((t) =>
          t.relayCounted
            ? `${t.service} ${CUTOVER_REVISION_FACTOR}×${t.maxInstances}×(${t.poolMax}+1)=${t.peak}`
            : `${t.service} ${CUTOVER_REVISION_FACTOR}×${t.maxInstances}×${t.perInstance}=${t.peak}`,
        )
        .join(" + ")} + admin ${budget.adminReserve})`;
    if (isProd(env)) failures.push(detail);
    else warnings.push(`${detail} — non-fatal on ${env} per spec-518 dec-5`);
  }

  return { fatal: failures.length > 0, failures, warnings };
}

// ── Emission: the deploy is the only witness these criteria have ──────────────
//
// Five of this Spec's acceptance criteria assert something about a DEPLOY — "after any
// prod deploy the applied values equal the pinned ones", "prod serves maxScale 8 /
// minScale 1", "total prod connections stay below the ceiling, verified in
// pg_stat_activity". No unit test can move them: their subject is a real cutover
// against a real database, and the only process that observes it is this guard.
//
// Memex derives an AC's verification state from `test_events` — there is no "mark
// verified" field — so without an emitter these read UNTESTED forever while being
// checked on every single deploy. That is the same shape as the untagged assertion
// that left ac-17 red: a green check nobody is told about.
//
// The semantics this buys are better than a test's, not merely equivalent:
//   pass   every prod deploy that clears both gates
//   fail   the first one that does not — which is the signal that matters
//   stale  after 7 days with no deploy, because "after ANY prod deploy" SHOULD
//          expire when deploys stop. A unit test cannot express that; this can.
export const DEPLOY_OBSERVED_ACS = {
  /** the applied values match the intended per-env plan, read off the live revision */
  appliedMatchesPlan: "ac-14",
  /** live maxScale/minScale/DB_POOL_MAX equal that env's deploy-env secret */
  equalsSecret: "ac-9",
  /** no silent scale-down to 3, no console-only drift, after ANY prod deploy */
  noDrift: "ac-1",
  /** maxScale raised from 3 and minScale ≥ 1, surviving every deploy */
  ceilingDurablyHigher: "ac-6",
  /** total connections stay below the effective ceiling — pg_stat_activity */
  belowCeiling: "ac-2",
} as const;

const SPEC_ACS = "mindset-prod/memex-building-itself/specs/spec-518/acs";

export type Emission = { ac_uid: string; status: "pass" | "fail" };

/**
 * Which criteria this run is entitled to speak for, and with what verdict.
 *
 * Three refusals, each deliberate:
 *
 * - **`plan` mode emits nothing.** Nothing has been applied yet; a green from the
 *   pre-flight would assert an outcome that has not happened.
 * - **Only prod emits.** ac-14, ac-1 and ac-6 name prod explicitly, and int's config is
 *   deliberately unset (t-4) so its comparison is vacuous. An int deploy turning a
 *   prod-shaped criterion green is exactly the lie this Spec exists to stop.
 * - **A run that could not READ emits nothing** — not even a fail. "We didn't look" and
 *   "we looked and it was wrong" are different facts, and only the second is a verdict.
 */
export function planEmissions({
  mode,
  env,
  observed,
  fatal,
  connectionsInUse,
  usable,
}: {
  mode: "plan" | "applied";
  env: string;
  /** true when the live reads (gcloud + Postgres) all succeeded */
  observed: boolean;
  fatal: boolean;
  /** from pg_stat_activity; undefined when it could not be read */
  connectionsInUse?: number;
  usable?: number;
}): Emission[] {
  if (mode !== "applied" || !isProd(env) || !observed) return [];

  const verdict: "pass" | "fail" = fatal ? "fail" : "pass";
  const emissions: Emission[] = [
    DEPLOY_OBSERVED_ACS.appliedMatchesPlan,
    DEPLOY_OBSERVED_ACS.equalsSecret,
    DEPLOY_OBSERVED_ACS.noDrift,
    DEPLOY_OBSERVED_ACS.ceilingDurablyHigher,
  ].map((ac) => ({ ac_uid: `${SPEC_ACS}/${ac}`, status: verdict }));

  // ac-2 is a separate OBSERVATION, not the same verdict re-stated: it asks what
  // pg_stat_activity actually shows, which is a different question from whether the
  // configuration matched. Emitted only when that read succeeded.
  if (connectionsInUse !== undefined && usable !== undefined) {
    emissions.push({
      ac_uid: `${SPEC_ACS}/${DEPLOY_OBSERVED_ACS.belowCeiling}`,
      status: connectionsInUse < usable ? "pass" : "fail",
    });
  }

  return emissions;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

/** The enumeration a reader needs to spot a term that should be there and isn't. */
export function formatBudgetReport(budget: Budget): string[] {
  // The per-term line states WHERE its number came from, and — since t-15 — no longer
  // claims a relay LISTEN it did not add. Printing `+ 1 relay LISTEN` on a line counted
  // from a complete declaration was the counted-vs-real confusion removed from the
  // arithmetic and left standing in what a human reads (spec-525 t-15).
  const lines = budget.terms.map((t) => {
    const shape = t.relayCounted
      ? `(pool ${t.poolMax} [${t.poolSource}] + ${RELAY_LISTEN_PER_INSTANCE} relay LISTEN)`
      : `(${t.perInstance} per instance [${t.poolSource}])`;
    return (
      `    ${t.service}${t.revision ? ` (${t.revision})` : ""}: ` +
      `maxInstances ${t.maxInstances} × ${shape} = ${t.steady} steady, ${t.peak} at cutover`
    );
  });
  lines.push(`    admin / migration reserve: ${budget.adminReserve}`);
  lines.push(
    `    TOTAL: ${budget.steadyTotal} steady, ${budget.peakTotal} at cutover, against ${budget.usable} usable ` +
      `→ ${budget.withinBudget ? `${budget.headroom} spare` : `OVER by ${-budget.headroom}`}`,
  );
  return lines;
}

// ── Reading the applied truth out of gcloud JSON ──────────────────────────────
//
// `gcloud run services describe` returns `spec.template` — what the NEXT revision would get.
// That is intent, and reading it would ship a second source-reader with extra steps. The applied
// truth lives on the revision that traffic is actually on.

export type RevisionScaling = {
  revision?: string;
  /** `undefined` when the service never set `maxScale` — Cloud Run's own default then applies. */
  maxInstances?: number;
  /** Cloud Run omits the annotation entirely at 0, so absent reads as 0 here. */
  minInstances: number;
  /** `undefined` = no `DB_POOL_MAX` on the revision. Feeds the comparison only, never the budget. */
  dbPoolMax?: number;
  /** `undefined` = the revision declares no {@link DECLARATION_VAR}: refused by phase B. */
  declaredPerInstance?: number;
  cloudSqlInstances: string[];
};

const MAX_SCALE = "autoscaling.knative.dev/maxScale";
const MIN_SCALE = "autoscaling.knative.dev/minScale";
const CLOUD_SQL = "run.googleapis.com/cloudsql-instances";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRevisionScaling(json: unknown): RevisionScaling {
  const root = asRecord(json);
  const metadata = asRecord(root.metadata);
  const annotations = asRecord(metadata.annotations);
  const containers = asRecord(root.spec).containers;
  const first = Array.isArray(containers) ? asRecord(containers[0]) : {};
  const env = Array.isArray(first.env) ? first.env.map(asRecord) : [];
  const pool = env.find((e) => e.name === "DB_POOL_MAX");
  // Read beside DB_POOL_MAX, not instead of it: DB_POOL_MAX still feeds the applied-vs-
  // intended comparison, while only the declaration feeds the budget (see serviceTerm).
  const declared = env.find((e) => e.name === DECLARATION_VAR);

  return {
    revision: typeof metadata.name === "string" ? metadata.name : undefined,
    maxInstances: asNumber(annotations[MAX_SCALE]),
    // 0 and undefined are NOT the same thing elsewhere in this module, but they are here:
    // Cloud Run drops the annotation at minScale 0, which is int's live shape.
    minInstances: asNumber(annotations[MIN_SCALE]) ?? 0,
    dbPoolMax: asNumber(pool?.value),
    declaredPerInstance: asNumber(declared?.value),
    cloudSqlInstances: String(annotations[CLOUD_SQL] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function parseServingRevisions(json: unknown): {
  serving: string[];
  latestReady?: string;
} {
  const status = asRecord(asRecord(json).status);
  const traffic = Array.isArray(status.traffic) ? status.traffic.map(asRecord) : [];
  const serving = traffic
    // A 0% entry is a tag or a leftover, not a consumer of instances. Anything above 0 is
    // serving, and during a split EVERY serving revision holds its own pool.
    .filter((t) => (asNumber(t.percent) ?? 0) > 0)
    .map((t) => (typeof t.revisionName === "string" ? t.revisionName : ""))
    .filter(Boolean);
  return {
    serving,
    latestReady:
      typeof status.latestReadyRevisionName === "string" ? status.latestReadyRevisionName : undefined,
  };
}
