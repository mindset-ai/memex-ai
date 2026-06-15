import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs, no types needed.
import { diffSchemas } from "../scripts/drift-gate.mjs";

// spec-279 t-3 — the drift gate.

const GATE = resolve(__dirname, "..", "scripts", "drift-gate.mjs");
const SERVER_DIR = resolve(__dirname, "..", "..", "server");
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
const TEST_DB = "memex_driftgate_itest";
const TEST_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB}`;

const map = (obj: Record<string, string[]>) =>
  new Map(Object.entries(obj).map(([t, cols]) => [t, new Set(cols)]));

describe("ac-10 — diff core: red on a schema→DB divergence, green/info otherwise", () => {
  it("reports no failures when the package schema is fully present in the DB", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-10");
    const { failures } = diffSchemas(
      map({ documents: ["id", "title"] }),
      map({ documents: ["id", "title"] }),
    );
    expect(failures).toEqual([]);
  });

  it("FAILS when the DB is missing a table or column the package declares", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-10");

    const missingTable = diffSchemas(map({ documents: ["id"], acs: ["id"] }), map({ documents: ["id"] }));
    expect(missingTable.failures).toContain("missing table in DB: acs");

    const missingCol = diffSchemas(map({ documents: ["id", "title"] }), map({ documents: ["id"] }));
    expect(missingCol.failures).toContain("missing column in DB: documents.title");
  });

  it("treats DB-only tables/columns as info, never as failures (typed-subset contract)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-10");
    const { failures, info } = diffSchemas(
      map({ documents: ["id"] }),
      map({ documents: ["id", "embedding"], manual_migrations: ["id"] }),
    );
    expect(failures).toEqual([]);
    expect(info).toContain("extra column in DB (not modelled): documents.embedding");
    expect(info).toContain("extra table in DB (not modelled by the package): manual_migrations");
  });
});

describe("ac-3 / ac-10 — the gate runs against a freshly-migrated cold DB", () => {
  beforeAll(() => {
    // Fail loudly (not skip) if Postgres is unreachable — a real prerequisite.
    const ping = spawnSync("pg_isready", ["-h", "localhost", "-p", "5432"]);
    if (ping.status !== 0) throw new Error("Postgres must be running on localhost:5432 for the drift-gate integration test");

    // Cold database, fully migrated (drizzle journal + hand migrations).
    execFileSync("psql", [ADMIN_URL, "-q", "-c", `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`, "-c", `CREATE DATABASE ${TEST_DB};`]);
    execFileSync("pnpm", ["db:migrate"], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: "ignore" });
  }, 120_000);

  afterAll(() => {
    execFileSync("psql", [ADMIN_URL, "-q", "-c", `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`]);
  });

  const runGate = () => spawnSync("node", [GATE], { env: { ...process.env, DATABASE_URL: TEST_URL }, encoding: "utf8" });

  it("passes (exit 0) when the package matches the migrated DB", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-3");
    const res = runGate();
    expect(res.stdout).toContain("every table/column the package declares exists in the DB");
    expect(res.status, res.stderr).toBe(0);
  });

  it("fails (non-zero exit) on a deliberately-diverged DB", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-10");
    // Drop a column the package's schema declares → the package is now stale vs the DB.
    execFileSync("psql", [TEST_URL, "-q", "-c", "ALTER TABLE documents DROP COLUMN title;"]);
    const res = runGate();
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("missing column in DB: documents.title");
  });
});

// The drift gate must exist as a CI check (ac-3): assert the workflow runs it.
describe("ac-3 — a CI drift gate exists", () => {
  it("the db-schema-drift workflow migrates a cold DB and runs the gate", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-3");
    const wf = readFileSync(resolve(__dirname, "..", "..", "..", ".github", "workflows", "db-schema-drift.yml"), "utf8");
    expect(wf).toContain("pgvector/pgvector:pg16");
    expect(wf).toContain("pnpm db:migrate");
    expect(wf).toContain("node packages/db-schema/scripts/drift-gate.mjs");
  });
});
