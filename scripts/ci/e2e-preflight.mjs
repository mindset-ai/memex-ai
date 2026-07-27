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
import { resolveE2eConfig, resolveWorkspaceId } from "./workspace-alloc.mjs";

const SELF = "scripts/ci/e2e-preflight.mjs";

// ── Pure cores (exported so the regression test can drive them) ──────────────

/** Classify what is listening on our e2e API port.
 *  `probe` is injected so the test can drive every branch without real sockets. */
export async function classifyPortOwner({ port, expectedWorkspaceId, probe }) {
  const health = await probe(port);
  if (health === null) return { kind: "free" };
  if (typeof health !== "object") return { kind: "foreign", reason: "non-json" };
  const seen = health.workspace ?? null;
  if (seen === null) return { kind: "unidentified" };
  if (seen !== expectedWorkspaceId) return { kind: "foreign", reason: "mismatch", seen };
  return { kind: "own" };
}

/** True when the built dist is older than any source file (or missing entirely). */
export function isStaleBuild(distDir, srcDir, { listFiles = walk } = {}) {
  if (!existsSync(distDir)) return { stale: true, reason: "missing" };
  const newestOf = (dir) =>
    listFiles(dir).reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
  const distTime = newestOf(distDir);
  const srcTime = newestOf(srcDir);
  if (distTime === 0) return { stale: true, reason: "empty" };
  if (srcTime > distTime) {
    return { stale: true, reason: "older-than-src", distTime, srcTime };
  }
  return { stale: false };
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Does this Postgres need a password we are not supplying? */
export function needsPgPassword({ env, runPsql }) {
  if (env.PGPASSWORD) return false;
  try {
    runPsql();
    return false; // connected fine without a password (trust auth / .pgpass)
  } catch (err) {
    const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
    return /password/i.test(text);
  }
}

// ── Real probes ──────────────────────────────────────────────────────────────

async function httpHealth(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { unhealthy: res.status };
    return await res.json();
  } catch {
    return null; // nothing listening, or not speaking HTTP — treat as free
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

const failures = [];
const warnings = [];
let checksRun = 0;

function fail(message) {
  failures.push(message);
}

async function checkPortOwnership(cfg) {
  checksRun++;
  const verdict = await classifyPortOwner({
    port: cfg.apiPort,
    expectedWorkspaceId: cfg.workspaceId,
    probe: httpHealth,
  });

  if (verdict.kind === "free" || verdict.kind === "own") return;

  const owner =
    verdict.kind === "unidentified"
      ? "an unidentified server (it did not report a workspace, so it was not started by this tooling)"
      : `a server belonging to workspace ${verdict.seen ?? "(unparseable)"}`;

  fail(
    `E2E PORT BELONGS TO ANOTHER WORKSPACE (spec-512 dec-3)\n` +
      `\n` +
      `  Port ${cfg.apiPort} is already held by ${owner}.\n` +
      `  This workspace is ${cfg.workspaceRoot} (id ${cfg.workspaceId}).\n` +
      `\n` +
      `  Playwright is configured with reuseExistingServer, so it would have REUSED\n` +
      `  that server instead of starting this checkout's. Your journeys would have\n` +
      `  run against the OTHER workspace's code and the OTHER workspace's database,\n` +
      `  and reported a PASS. Nothing you just changed would have been tested.\n` +
      `\n` +
      `  Fix — free the port by stopping whatever holds it:\n` +
      `    lsof -ti tcp:${cfg.apiPort} | xargs kill\n` +
      `\n` +
      `  Or leave it running and give this run its own adjacent pair:\n` +
      `    E2E_SERVER_PORT=${cfg.apiPort + 2} E2E_UI_PORT=${cfg.apiPort + 3} make e2e-cold\n` +
      `\n` +
      `  Check: ${SELF}`,
  );
}

function checkPgPassword() {
  checksRun++;
  const blocked = needsPgPassword({
    env: process.env,
    runPsql: () =>
      execFileSync("psql", ["-h", "localhost", "-U", "postgres", "-At", "-c", "SELECT 1", "postgres"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }),
  });
  if (!blocked) return;

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
  checksRun++;
  const dist = join(repoRoot, "packages", "shared", "dist");
  const src = join(repoRoot, "packages", "shared", "src");
  if (!existsSync(src)) return; // layout changed — say nothing rather than guess
  const verdict = isStaleBuild(dist, src);
  if (!verdict.stale) return;

  const detail =
    verdict.reason === "missing"
      ? "packages/shared/dist does not exist"
      : verdict.reason === "empty"
        ? "packages/shared/dist is empty"
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

async function main() {
  const repoRoot = process.env.MEMEX_WORKSPACE_ROOT ?? process.cwd();
  const cfg = resolveE2eConfig(process.env, repoRoot);

  await checkPortOwnership(cfg);
  checkPgPassword();
  checkSharedBuild(repoRoot);
  checkEmissionTarget();

  // Guard against the lie this whole Spec exists to eliminate: a preflight that
  // examined nothing would otherwise print a clean bill of health.
  if (checksRun === 0) {
    process.stderr.write(
      `e2e-preflight ran ZERO checks — that is a defect in the preflight itself,\n` +
        `not a clean run. Check: ${SELF}\n`,
    );
    return 2;
  }

  for (const w of warnings) process.stdout.write(`⚠ ${w}\n\n`);

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.join("\n\n")}\n\n`);
    process.stderr.write(
      `e2e preflight FAILED — ${failures.length} of ${checksRun} checks tripped. ` +
        `Refusing to start a run that could report a false pass.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `✓ e2e preflight passed (${checksRun} checks) — workspace ${cfg.workspaceId}, ` +
      `api:${cfg.apiPort} ui:${cfg.uiPort} db:${cfg.databaseName}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
