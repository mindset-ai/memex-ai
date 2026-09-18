// e2e preflight (spec-512 dec-3) — refuse to start an e2e run that would lie.
//
// Every check here exists because the failure it catches is SILENT or
// INDISTINGUISHABLE from an unrelated problem. Each one was paid for at least
// once and then written down as prose (packages/ui/e2e/README.md:20-49); this
// script is that prose converted into behaviour.
//
//   FOREIGN SERVER  playwright.config.ts sets `reuseExistingServer: !CI`. A second
//                   worktree finds ports already answering and reuses ANOTHER
//                   worktree's servers — running its journeys against a different
//                   branch's code and database, and reporting PASS. Proven
//                   empirically during spec-512 build: a stub server on the e2e
//                   port received 12 real requests (health, ensure-user,
//                   clear-user-specs, …) while Playwright never booted this
//                   checkout's server at all.
//   PGPASSWORD      `make e2e-cold`'s dropdb/createdb carry no password (unlike its
//                   `psql -f` steps, which embed it in the URL), so on an
//                   auth-requiring Postgres they block on a hidden `Password:`
//                   prompt with ZERO output — looks like a slow build, hangs forever.
//   STALE SHARED    A stale packages/shared/dist missing an export the UI now
//                   imports throws a module-load SyntaxError, React never mounts,
//                   and EVERY journey fails identically with a generic
//                   "heading not found". The real error is visible only in trace.zip.
//   EMISSION        A local run with emission on POSTs REAL test_events to
//                   production memex.ai.
//
// Message contract (spec-512): every failure prints the broken invariant with
// observed values, an exact copy-pasteable one-line fix, and this file's path.
// An invariant breach exits non-zero; genuine informational degradations warn.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveE2eConfig } from "./workspace-alloc.mjs";

const SELF = "scripts/ci/e2e-preflight.mjs";

// ── Pure cores (exported so the regression test can drive them) ──────────────

/** Classify what is listening on our e2e API port.
 *  `probe` is injected so the test can drive every branch without real sockets. */
export async function classifyPortOwner({ port, expectedWorkspaceId, probe }) {
  const health = await probe(port);

  // ONLY a refused connection means "free". Everything else means something is
  // listening, and anything listening that cannot PROVE it is ours must fail loud.
  //
  // Adversarial review broke the first version here twice, both times by making a
  // real foreign server look like an empty port:
  //   * a server slower than the probe timeout — 1500ms was caught, 2100ms sailed
  //     through with "✓ preflight passed", even though the server's own log showed
  //     it had RECEIVED the probe. Playwright's webServer timeout is 60s, so a 3s
  //     server is adopted comfortably.
  //   * a 200 whose body is not JSON (an SPA HTML fallback, an empty body, a
  //     redirect) — `res.json()` threw into the same catch that handles ECONNREFUSED.
  // Both reinstated the exact silent adoption this file exists to prevent, which is
  // why the sentinels below are distinct rather than collapsed into null.
  if (health === null) return { kind: "free" };
  if (typeof health !== "object") return { kind: "foreign", reason: "non-json" };
  if (health.timedOut) return { kind: "unidentified", reason: "timeout" };
  if (health.unparseable) return { kind: "unidentified", reason: "non-json" };
  if (health.unhealthy !== undefined) return { kind: "unidentified", reason: "unhealthy" };

  // Treat null/""/whitespace alike — an unusable id is no id.
  const raw = health.workspace;
  const seen = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  if (seen === null) return { kind: "unidentified", reason: "no-id" };
  if (seen !== expectedWorkspaceId) return { kind: "foreign", reason: "mismatch", seen };
  return { kind: "own" };
}

/** The ports a run must clear before it can trust its own results.
 *  Exported so the guard's test can assert coverage BEHAVIOURALLY — counting
 *  `checkPortOwnership(` lines in the source was defeatable by a call wrapped in
 *  an `if`, or by the same text inside a string literal (both kept the old test
 *  green while the UI port went unprobed). */
export function portsToCheck(cfg) {
  return [
    { port: cfg.apiPort, label: "API" },
    { port: cfg.uiPort, label: "UI" },
  ];
}

/** Is the built dist missing, empty, older than source, or INCOMPLETE?
 *
 *  Adversarial review broke the max-mtime-only version: a `dist` holding 1 of 38
 *  modules reported `{stale:false}`, and a single `touch` on any one dist file
 *  cleared a genuine stale verdict while a source module remained unbuilt. That
 *  is exactly the interrupted-build case the check exists for — the header below
 *  says it guards "a stale dist MISSING AN EXPORT the UI now imports", and a
 *  newest-mtime comparison is structurally blind to a missing file.
 *
 *  So compare COVERAGE as well as recency: every source module must have a
 *  corresponding emitted module. */
export function isStaleBuild(distDir, srcDir, { listFiles = walk } = {}) {
  if (!existsSync(distDir)) return { stale: true, reason: "missing" };

  const srcFiles = listFiles(srcDir).filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.tsx?$/.test(f),
  );
  const distFiles = listFiles(distDir).filter((f) => /\.js$/.test(f));

  if (distFiles.length === 0) return { stale: true, reason: "empty" };

  // Coverage: a source module with no emitted counterpart means a partial build.
  const emitted = new Set(
    distFiles.map((f) => f.slice(distDir.length).replace(/\.js$/, "")),
  );
  const missing = srcFiles
    .map((f) => f.slice(srcDir.length).replace(/\.tsx?$/, ""))
    .filter((rel) => !emitted.has(rel));
  if (missing.length > 0) {
    return {
      stale: true,
      reason: "incomplete",
      missingCount: missing.length,
      srcCount: srcFiles.length,
      example: missing[0],
    };
  }

  const newestOf = (files) =>
    files.reduce((max, f) => {
      // A broken symlink throws ENOENT from statSync. Skip it rather than crash
      // the whole preflight with a bare stack trace (which would breach the
      // message contract) — a dangling link tells us nothing about freshness.
      try {
        return Math.max(max, statSync(f).mtimeMs);
      } catch {
        return max;
      }
    }, 0);
  const distTime = newestOf(distFiles);
  const srcTime = newestOf(srcFiles);
  if (srcTime > distTime) {
    return { stale: true, reason: "older-than-src", distTime, srcTime };
  }
  return { stale: false };
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — callers treat an empty listing as "nothing built"
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Does this Postgres need a password we are not supplying? */
export function needsPgPassword({ env, runPsql }) {
  if (env.PGPASSWORD) return { blocked: false, examined: true };
  try {
    runPsql();
    return { blocked: false, examined: true }; // trust auth / .pgpass
  } catch (err) {
    const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
    if (/password/i.test(text)) return { blocked: true, examined: true };
    // psql absent, or Postgres down. We learned nothing about password policy,
    // so this must NOT count as a check that passed (adversarial review: the
    // earlier boolean return silently no-opped while still counting).
    return { blocked: false, examined: false, why: text.trim().split("\n")[0] };
  }
}


/** The notice a bypassed run carries. Exported and pure so ac-16 is asserted on
 *  the words rather than on whatever else this machine's preflight happens to
 *  find. Printed on BOTH paths — a run that was bypassed AND tripped some other
 *  check must still say it was bypassed, or the loudness bound only holds on the
 *  happy path, which is the half that needed it least. */
export function describeCapabilityBypass(names) {
  return (
    `⚠ THE CAPABILITY PROBE WAS BYPASSED — ${names.join(", ")} is set, so nothing\n` +
    `  checked whether this Postgres can replay the migrations. If the run dies\n` +
    `  inside a migration, that is why. This run is NOT a clean preflight.\n` +
    `  Unset it to restore the check.\n`
  );
}

/** The ONE escape hatch, and it is deliberately narrow (spec-524 dec-3, ac-15).
 *  It disarms the capability probe and nothing else. There is no variable that
 *  turns the preflight off as a whole: a blanket switch would hand anyone working
 *  around one mistaken probe the power to disarm four unrelated guards, and the
 *  hatch exists only because a wrong probe on a required check blocks everybody.
 *  CI never sets it (ac-17) — if it appears in a workflow that is a defect. */
export const PG_CAPABILITY_BYPASS = "E2E_SKIP_PG_CAPABILITY_CHECK";

/** One round trip for the three facts. Exported so a test can assert the port
 *  comes from `inet_server_port()` — the SERVER's answer — rather than from a
 *  value we recomputed out of the environment (ac-23, [per std-50]). */
export const PG_CAPABILITY_QUERY =
  "SELECT current_setting('server_version'), " +
  "EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector'), " +
  "COALESCE(inet_server_port()::text, '')";

/** The refusal a developer reads. Pure and exported: the end-to-end behaviour
 *  depends on what Postgres this machine happens to run (CI's 5432 IS capable),
 *  so a test that shelled out would be red in CI and green here — machine-shaped,
 *  not claim-shaped. ac-13 is about the WORDS, so the words are the unit. */
export function describePgCapabilityFailure(verdict) {
  return (
    `The target Postgres cannot replay the migrations.\n` +
    `  The connection landed on port ${verdict.port}, PostgreSQL ${verdict.version},\n` +
    `  and \`vector\` is NOT in pg_available_extensions.\n` +
    `  Consequence: packages/server/drizzle/0023_add_codebase_intelligence.sql\n` +
    `  will fail with "could not open extension control file ... vector.control",\n` +
    `  about nine minutes from now, naming no cause.\n\n` +
    `  Fix: point the run at a pgvector-capable instance by declaring it once in\n` +
    `  the repo-root .env (template: .env.example):\n` +
    `      PGPORT=<port of your pgvector-capable Postgres>\n` +
    `  Find one:  pg_lsclusters    (or: psql -p <port> -c "select 1 from pg_available_extensions where name='vector'")\n` +
    `  Check: ${SELF}`
  );
}

/** Can the target Postgres replay the migrations?
 *
 *  spec-524 ac-12/ac-13/ac-23. The failure this closes: `make e2e-cold` replays
 *  drizzle/*.sql into the template and dies inside 0023_add_codebase_intelligence
 *  with `could not open extension control file .../vector.control` — nine minutes
 *  in, naming no cause. The capability is knowable in milliseconds beforehand.
 *
 *  Deliberately checks ONE thing: is `vector` available. NOT a server-version
 *  floor, even though an earlier draft of ac-12 asked for one. pgvector runs on
 *  Postgres 14 perfectly well; the observed defect is an extension that is not
 *  INSTALLED for that cluster, which is orthogonal to the version. Refusing on a
 *  version we cannot read a requirement for would be inventing a constraint
 *  [per std-50], and on a required check a wrong refusal blocks every PR.
 *  The version is carried anyway, as diagnosis.
 *
 *  Pure: takes the probe's reading, returns a verdict. `examined: false` when the
 *  probe learned nothing — an unexamined check must never count as a passed one. */
export function classifyPgCapability(reading) {
  if (!reading || reading.unreachable) {
    return { ok: true, examined: false, why: reading?.why ?? "no reading" };
  }
  if (reading.vectorAvailable) return { ok: true, examined: true };
  return {
    ok: false,
    examined: true,
    version: reading.version,
    // ac-23: the port is what the SERVER said, via inet_server_port(), not a
    // value recomputed from the environment. Where a variable and reality
    // disagree, reality is what prints. NULL over a unix socket, so say so in
    // words rather than rendering a blank.
    port: reading.port ?? "unix socket",
  };
}

// ── Real probes ──────────────────────────────────────────────────────────────

async function httpHealth(port) {
  let res;
  try {
    res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    // A timeout means something IS there and merely answered slowly — never free.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { timedOut: true };
    }
    return null; // connection refused: genuinely nothing listening
  }
  if (!res.ok) return { unhealthy: res.status };
  try {
    return await res.json();
  } catch {
    // Answered 200 with a body we cannot parse (SPA HTML, empty, redirect body).
    // Something is listening and cannot identify itself.
    return { unparseable: true };
  }
}


// One round trip, three facts: whether `vector` can be installed, what server we
// actually reached, and — ac-23 — which port the SERVER says we landed on. The
// port is read from the connection rather than recomputed from PGPORT so that a
// variable disagreeing with reality prints reality. `inet_server_port()` is NULL
// over a unix socket; the classifier turns that into words, not a blank.
//
// Connects to the `postgres` maintenance database: the e2e database and its
// template do not exist yet at preflight time, which is the whole point of
// asking before the run rather than during it.
function probePgCapability(cfg) {
  const url = new URL(cfg.databaseUrl);
  url.pathname = "/postgres";
  try {
    const out = execFileSync(
      "psql",
      [
        url.toString(),
        "-At",
        "-c",
        PG_CAPABILITY_QUERY,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 5000, encoding: "utf8" },
    );
    const [version, vector, port] = out.trim().split("|");
    return {
      version,
      vectorAvailable: vector === "t",
      port: port || null,
    };
  } catch (err) {
    // psql absent, Postgres down, wrong credentials — we learned NOTHING about
    // capability, so this must read as unexamined rather than as a pass. The
    // pg-password check ahead of us already speaks for the credential case.
    const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
    return { unreachable: true, why: text.trim().split("\n")[0] };
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

const failures = [];
const warnings = [];
const skipped = [];
const bypassed = [];
let checksRun = 0;

function fail(message) {
  failures.push(message);
}

// Playwright's webServer block has TWO entries — the API server AND the Vite UI
// server — and `reuseExistingServer` applies to BOTH. Checking only the API port
// leaves the exact same silent lie available through the other door: a free API
// port and a foreign UI port means Playwright boots our API, reuses THEIR UI, and
// the journeys drive another workspace's bundle. (Found by adversarial review of
// the first cut of this file, which probed only the API port and merely PRINTED
// the UI port in its success line — the reassuring-but-unchecked shape this whole
// Spec exists to eliminate.)
//
// The UI port is a Vite dev server with no /api/health of its own, but it PROXIES
// /api/* to whichever API it was configured against — so probing health through it
// answers the sharper question: which API is this UI actually wired to?
async function checkPortOwnership(cfg, { port, label }) {
  checksRun++;
  const verdict = await classifyPortOwner({
    port,
    expectedWorkspaceId: cfg.workspaceId,
    probe: httpHealth,
  });

  if (verdict.kind === "free" || verdict.kind === "own") return;

  const owner =
    verdict.kind === "unidentified"
      ? "an unidentified server (it did not report a workspace, so it was not started by this tooling)"
      : `a server belonging to workspace ${verdict.seen ?? "(unparseable)"}`;

  fail(
    `E2E ${label} PORT BELONGS TO ANOTHER WORKSPACE (spec-512 dec-3)\n` +
      `\n` +
      `  Port ${port} (the ${label} server) is already held by ${owner}.\n` +
      `  This workspace is ${cfg.workspaceRoot} (id ${cfg.workspaceId}).\n` +
      `\n` +
      `  Playwright is configured with reuseExistingServer for BOTH its API and UI\n` +
      `  servers, so it would have REUSED that one instead of starting this\n` +
      `  checkout's. Your journeys would have run against the OTHER workspace's code\n` +
      `  and the OTHER workspace's database, and reported a PASS. Nothing you just\n` +
      `  changed would have been tested.\n` +
      `\n` +
      `  Fix — free the port by stopping whatever holds it:\n` +
      // xargs -r, not `kill $(...)`: with an already-free port the command
      // substitution is empty and `kill` exits 1 with "not enough arguments",
      // so the printed fix would itself fail. Every printed fix must run.
      `    lsof -ti tcp:${port} | xargs -r kill\n` +
      `\n` +
      `  Or leave it running and give this run its own pair:\n` +
      `    E2E_SERVER_PORT=${cfg.apiPort + 100} E2E_UI_PORT=${cfg.uiPort + 100} make e2e-cold\n` +
      `\n` +
      `  Check: ${SELF}`,
  );
}

function checkPgPassword() {
  const verdict = needsPgPassword({
    env: process.env,
    runPsql: () =>
      execFileSync("psql", ["-h", "localhost", "-U", "postgres", "-At", "-c", "SELECT 1", "postgres"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }),
  });
  if (!verdict.examined) {
    skipped.push(`pg-password (could not reach psql/Postgres: ${verdict.why ?? "unknown"})`);
    return;
  }
  checksRun++;
  if (!verdict.blocked) return;

  fail(
    `POSTGRES REQUIRES A PASSWORD AND PGPASSWORD IS UNSET (spec-512 dec-3)\n` +
      `\n` +
      `  Connecting as postgres@localhost failed asking for a password, and\n` +
      `  PGPASSWORD is not set in this environment.\n` +
      `\n` +
      `  make e2e-cold's dropdb/createdb steps carry no password (its psql -f steps\n` +
      `  embed one in the URL, which is why those work). Without PGPASSWORD they\n` +
      `  block on a hidden "Password:" prompt that prints NOTHING — the run looks\n` +
      `  like a slow build and hangs forever.\n` +
      `\n` +
      `  Fix:\n` +
      `    PGPASSWORD=postgres make e2e-cold\n` +
      `\n` +
      `  Check: ${SELF}`,
  );
}

function checkSharedBuild(repoRoot) {
  const dist = join(repoRoot, "packages", "shared", "dist");
  const src = join(repoRoot, "packages", "shared", "src");
  if (!existsSync(src)) {
    // Layout changed — say nothing rather than guess. Deliberately does NOT
    // increment checksRun: a check that examined nothing must not be reported
    // as a check that passed. Adversarial review caught the earlier version
    // printing "✓ 5 checks" from a run where this one inspected no files.
    skipped.push("shared-build (packages/shared/src not found)");
    return;
  }
  checksRun++;
  const verdict = isStaleBuild(dist, src);
  if (!verdict.stale) return;

  const detail =
    verdict.reason === "missing"
      ? "packages/shared/dist does not exist"
      : verdict.reason === "empty"
        ? "packages/shared/dist contains no emitted .js modules"
        : verdict.reason === "incomplete"
          ? `packages/shared/dist is INCOMPLETE — ${verdict.missingCount} of ` +
            `${verdict.srcCount} source modules have no emitted counterpart ` +
            `(e.g. "${verdict.example}"). A build was interrupted, or died partway.`
          : `packages/shared/src is newer than packages/shared/dist ` +
            `(src ${new Date(verdict.srcTime).toISOString()} > dist ${new Date(verdict.distTime).toISOString()})`;

  fail(
    `@memex/shared BUILD IS STALE (spec-512 dec-3)\n` +
      `\n` +
      `  ${detail}.\n` +
      `\n` +
      `  The UI imports @memex/shared from its dist. When dist is missing an export\n` +
      `  the UI now uses, the browser throws a module-load SyntaxError, React never\n` +
      `  mounts, and EVERY journey fails identically with a generic "heading not\n` +
      `  found" timeout — the real error is only visible inside trace.zip. That\n` +
      `  looks exactly like a broken test and costs an afternoon.\n` +
      `\n` +
      `  Fix:\n` +
      `    pnpm --filter @memex/shared build\n` +
      `\n` +
      `  Check: ${SELF}`,
  );
}

function checkEmissionTarget() {
  checksRun++;
  const emit = process.env.MEMEX_EMIT;
  const off = emit === "off" || emit === "false" || emit === "0";
  if (off) return;
  if (!process.env.MEMEX_EMIT_KEY) {
    // No key: emissions are rejected 401 and dropped. Informational, not fatal —
    // the run is still honest about the code under test.
    warnings.push(
      `AC emission is on but MEMEX_EMIT_KEY is unset — events will be rejected 401\n` +
        `  and silently dropped, so no AC will verify from this run. Proceeding.\n` +
        `  Silence it with: MEMEX_EMIT=off make e2e-cold`,
    );
    return;
  }
  warnings.push(
    `AC emission is ON with a key set — this run will POST REAL test_events to the\n` +
      `  configured Memex (production memex.ai unless overridden). Proceeding.\n` +
      `  Suppress with: MEMEX_EMIT=off make e2e-cold`,
  );
}

// ── Entrypoint ───────────────────────────────────────────────────────────────


// spec-524 dec-3. The preflight's four original checks all asked "is something
// else in the way?". None asked the question that actually kills the run: can
// this Postgres run our migrations at all? dec-2 made the server configurable,
// not correct — a PGPORT aimed at a cluster without pgvector still dies in 0023,
// just more tidily — so this check is now the only thing between a developer and
// nine minutes of run that cannot mean anything.
async function checkPgCapability(cfg) {
  if (process.env[PG_CAPABILITY_BYPASS]) {
    // ac-16: a bypassed run must not be able to read as a clean one. The same
    // principle the gate applies to a meaningless test run, applied to the hatch.
    bypassed.push(PG_CAPABILITY_BYPASS);
    return;
  }
  const reading = probePgCapability(cfg);
  const verdict = classifyPgCapability(reading);

  if (!verdict.examined) {
    skipped.push(`postgres capability (${verdict.why})`);
    return;
  }
  checksRun++;
  if (verdict.ok) return;

  fail(describePgCapabilityFailure(verdict));
}

async function main() {
  const repoRoot = process.env.MEMEX_WORKSPACE_ROOT ?? process.cwd();
  const cfg = resolveE2eConfig(process.env, repoRoot);

  for (const target of portsToCheck(cfg)) {
    await checkPortOwnership(cfg, target);
  }
  checkPgPassword();
  await checkPgCapability(cfg);
  checkSharedBuild(repoRoot);
  checkEmissionTarget();

  // A preflight that examined nothing must never print a clean bill of health.
  // Reachable now that checks which inspect nothing decline to count themselves.
  if (checksRun === 0) {
    process.stderr.write(
      `e2e-preflight ran ZERO real checks — that is a defect in the preflight\n` +
        `itself, not a clean run.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}\n` +
        `  Check: ${SELF}\n`,
    );
    return 2;
  }

  for (const w of warnings) process.stdout.write(`⚠ ${w}\n\n`);
  // Skips are stated, never swallowed — an unexamined check is not a passed one.
  for (const s of skipped) process.stdout.write(`⚠ check SKIPPED (examined nothing): ${s}\n`);

  // Before ANY verdict, clean or not: a bypassed run says so.
  if (bypassed.length > 0) process.stdout.write(describeCapabilityBypass(bypassed));

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.join("\n\n")}\n\n`);
    process.stderr.write(
      `e2e preflight FAILED — ${failures.length} of ${checksRun} checks tripped. ` +
        `Refusing to start a run that could report a false pass.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `${bypassed.length > 0 ? "⚠" : "✓"} e2e preflight passed (${checksRun} checks` +
      `${skipped.length ? `, ${skipped.length} skipped` : ""}) — ` +
      `workspace ${cfg.workspaceId}, api:${cfg.apiPort} ui:${cfg.uiPort} db:${cfg.databaseName}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // An unexpected throw must still meet the message contract, not dump a
      // bare stack trace (adversarial review tripped this with a broken symlink).
      process.stderr.write(
        `\ne2e-preflight CRASHED — it could not determine whether this run is safe,\n` +
          `so it is failing closed rather than letting the suite start.\n\n` +
          `  ${err?.stack ?? err}\n\n` +
          `  Fix: re-run with the underlying condition resolved, or bypass ONLY if you\n` +
          `  accept that the run may test another workspace's code:\n` +
          `    pnpm --filter @memex/ui test:e2e\n\n` +
          `  Check: ${SELF}\n`,
      );
      process.exit(2);
    });
}
