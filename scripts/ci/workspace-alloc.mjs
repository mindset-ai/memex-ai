// Per-workspace resource allocation (spec-512 dec-3).
//
// This repo is worked by parallel agents in many git worktrees at once (13 live
// when this was written). The vitest tier already isolates itself — see
// packages/server/src/db/test-db-url.ts, which derives `<base>_test_<sha1(root)[0:8]>`
// — but the e2e tier did not, and that gap made a green run a lie:
//
//   * Makefile hardcoded `memex_e2e` / `memex_e2e_template`, so a second worktree's
//     `dropdb --if-exists` destroyed the first one's database MID-RUN.
//   * playwright.config.ts pinned ports 8090/5173 with `reuseExistingServer: !CI`,
//     so a second worktree found those ports answering and SILENTLY reused the
//     first worktree's servers — running its journeys against another branch's
//     code and another branch's database, and reporting PASS.
//
// This module is the single allocator for both, so the Makefile and the Playwright
// harness can never disagree about which database or port is in play. Two sources
// of truth for a resource name is the exact class of bug being closed here.
//
// Every derivation is a pure function of the workspace root — deterministic,
// idempotent, no scanning for free ports. A scan would make the allocation depend
// on whatever else happened to be running, so the same workspace would get
// different ports on different days and a failure would be unreproducible. A
// genuine hash collision instead fails LOUDLY (see checkPortCollision) with the
// override to set. Rare and diagnosable beats common and invisible.

import { createHash } from "node:crypto";

// ── Derivation ───────────────────────────────────────────────────────────────

/** 8 hex chars of sha1(workspaceRoot). The stable identity of a working copy.
 *  Deliberately a hash, never the path: it rides on /api/health, which is an
 *  unauthenticated endpoint, so it must disclose nothing about the machine. */
export function workspaceHash(workspaceRoot) {
  return createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 8);
}

// Port window: [PORT_BASE, PORT_BASE + PORT_SLOTS*PORTS_PER_SLOT) must stay
// strictly below 49152, where macOS/BSD starts handing out ephemeral ports — a
// derived port inside that range can be stolen by an unrelated outbound socket
// between the preflight check and the server bind, producing exactly the
// intermittent, unreproducible failure this module exists to prevent.
//
// The first draft used 10000 slots and topped out at 59999 — well INSIDE the
// ephemeral range — while carrying a comment asserting the opposite. The
// regression test's arithmetic caught it. The bound below is now asserted in
// that test rather than trusted to prose: 20000 + 7000*4 = 48000 < 49152.
//
// 7000 slots keeps the birthday odds of two of ~20 concurrent worktrees
// colliding near 0.3% — and a collision is caught loudly, not tolerated.
const PORT_BASE = 20000;
const PORT_SLOTS = 7000;
const PORTS_PER_SLOT = 4;
const EPHEMERAL_FLOOR = 49152;

// Fail at import time rather than shipping a window that can be silently stolen.
if (PORT_BASE + PORT_SLOTS * PORTS_PER_SLOT > EPHEMERAL_FLOOR) {
  throw new Error(
    `workspace-alloc: port window [${PORT_BASE}, ${PORT_BASE + PORT_SLOTS * PORTS_PER_SLOT}) ` +
      `overlaps the ephemeral range (${EPHEMERAL_FLOOR}+). Derived ports could be stolen by the OS.\n` +
      `  Fix: lower PORT_SLOTS so PORT_BASE + PORT_SLOTS*PORTS_PER_SLOT <= ${EPHEMERAL_FLOOR}.\n` +
      `  Check: scripts/ci/workspace-alloc.mjs`,
  );
}

/** Ports for one workspace: { e2eApi, e2eUi, dev, devUi }. Pure, deterministic. */
export function derivePorts(workspaceRoot) {
  const hash = workspaceHash(workspaceRoot);
  const slot = Number.parseInt(hash, 16) % PORT_SLOTS;
  const base = PORT_BASE + slot * PORTS_PER_SLOT;
  return { e2eApi: base, e2eUi: base + 1, dev: base + 2, devUi: base + 3 };
}

/** e2e database names for one workspace. Postgres identifiers cap at 63 chars;
 *  the longest of these is 26, so there is no truncation hazard. */
export function deriveE2eDbNames(workspaceRoot) {
  const hash = workspaceHash(workspaceRoot);
  return { database: `memex_e2e_${hash}`, template: `memex_e2e_tpl_${hash}` };
}

/** Rewrite a Postgres URL's database name, preserving credentials/host/port/query. */
export function withDatabase(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

// ── Env-aware resolution (overrides always win) ──────────────────────────────

/** The workspace identity a server should advertise, or null when it should
 *  advertise nothing. Absent MEMEX_WORKSPACE_ID means "not a managed local
 *  workspace" — which is exactly the production posture, so /api/health stays
 *  byte-identical to what it has always returned. */
export function resolveWorkspaceId(env = process.env) {
  const explicit = env.MEMEX_WORKSPACE_ID;
  return explicit && explicit.trim() !== "" ? explicit.trim() : null;
}

/** Effective e2e config, with every pre-existing override honoured ahead of the
 *  derivation so no current workflow breaks. */
export function resolveE2eConfig(env = process.env, workspaceRoot = process.cwd()) {
  const ports = derivePorts(workspaceRoot);
  const names = deriveE2eDbNames(workspaceRoot);
  const baseUrl =
    env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";

  return {
    workspaceRoot,
    workspaceId: workspaceHash(workspaceRoot),
    // E2E_UI_PORT / E2E_SERVER_PORT predate this module (playwright.config.ts:15,18)
    // and remain the escape hatch.
    apiPort: Number(env.E2E_SERVER_PORT ?? ports.e2eApi),
    uiPort: Number(env.E2E_UI_PORT ?? ports.e2eUi),
    // An explicit E2E_DATABASE_URL is taken verbatim — someone naming a database
    // by hand means it, and silently rewriting it would be its own silent lie.
    databaseUrl: env.E2E_DATABASE_URL ?? withDatabase(baseUrl, names.database),
    templateUrl: withDatabase(baseUrl, names.template),
    databaseName: env.E2E_DATABASE_URL
      ? decodeURIComponent(new URL(env.E2E_DATABASE_URL).pathname.slice(1))
      : names.database,
    templateName: names.template,
    usingOverride: Boolean(env.E2E_DATABASE_URL),
  };
}

// ── CLI: `node scripts/ci/workspace-alloc.mjs <field>` ───────────────────────
// The Makefile shells out to this so there is exactly one allocator.

const FIELDS = {
  "workspace-id": (c) => c.workspaceId,
  "e2e-api-port": (c) => c.apiPort,
  "e2e-ui-port": (c) => c.uiPort,
  "e2e-database-url": (c) => c.databaseUrl,
  "e2e-template-url": (c) => c.templateUrl,
  "e2e-database-name": (c) => c.databaseName,
  "e2e-template-name": (c) => c.templateName,
};

function main(argv) {
  const field = argv[2];
  const cfg = resolveE2eConfig(process.env, process.env.MEMEX_WORKSPACE_ROOT ?? process.cwd());

  if (field === "--all" || field === undefined) {
    for (const [name, get] of Object.entries(FIELDS)) {
      process.stdout.write(`${name}=${get(cfg)}\n`);
    }
    return 0;
  }
  const get = FIELDS[field];
  if (!get) {
    process.stderr.write(
      `workspace-alloc: unknown field "${field}".\n` +
        `Known fields: ${Object.keys(FIELDS).join(", ")}\n` +
        `  Check: scripts/ci/workspace-alloc.mjs\n`,
    );
    return 2;
  }
  process.stdout.write(`${get(cfg)}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
