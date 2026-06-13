import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// spec-279 t-4 — the consumer contract. A standalone harness OUTSIDE this pnpm
// workspace installs the packed tarball, type-checks against its exported types,
// and opens a Drizzle + postgres connection that queries through the imported
// schema — proving Backstage can consume the package as published.

const PKG_DIR = resolve(__dirname, "..");
const SERVER_DIR = resolve(__dirname, "..", "..", "server");
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
const TEST_DB = "memex_consumer_itest";
const TEST_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB}`;

// A temp project that is NOT part of the workspace (lives under the OS tmpdir,
// outside packages/*), so node/tsc resolution can't reach into the monorepo.
let proj: string;
let tarball: string;

beforeAll(() => {
  const ping = spawnSync("pg_isready", ["-h", "localhost", "-p", "5432"]);
  if (ping.status !== 0) throw new Error("Postgres must be running on localhost:5432 for the consumer integration test");

  // Pack the real artifact. `npm pack` runs `prepare` (tsup) to build a fresh
  // dist; we derive the deterministic tarball name rather than parsing pack's
  // stdout (tsup's banner pollutes it).
  execFileSync("npm", ["pack"], { cwd: PKG_DIR, stdio: "ignore" });
  const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
  tarball = join(PKG_DIR, `${pkgJson.name.replace(/^@/, "").replace("/", "-")}-${pkgJson.version}.tgz`);

  // Fresh out-of-workspace consumer project; install the tarball + its peers.
  proj = mkdtempSync(join(tmpdir(), "db-schema-consumer-"));
  execFileSync("npm", ["init", "-y"], { cwd: proj, stdio: "ignore" });
  execFileSync("npm", ["pkg", "set", "type=module"], { cwd: proj, stdio: "ignore" });
  execFileSync("npm", ["install", tarball, "drizzle-orm@^0.39.0", "postgres@^3.4.5", "typescript@^5.7.0"], { cwd: proj, stdio: "ignore" });

  // A cold, migrated DB for the live query.
  execFileSync("psql", [ADMIN_URL, "-q", "-c", `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`, "-c", `CREATE DATABASE ${TEST_DB};`]);
  execFileSync("pnpm", ["db:migrate"], { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: "ignore" });
}, 180_000);

afterAll(() => {
  if (proj) rmSync(proj, { recursive: true, force: true });
  execFileSync("psql", [ADMIN_URL, "-q", "-c", `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`]);
  for (const f of readdirSync(PKG_DIR)) {
    if (f.startsWith("mindset-ai-db-schema-") && f.endsWith(".tgz")) rmSync(join(PKG_DIR, f), { force: true });
  }
});

describe("ac-11 — standalone harness installs the tarball, type-checks, and queries via Drizzle", () => {
  it("the installed package resolves and type-checks against its exported types", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-11");

    // A consumer .ts that uses both a value export (table) and a type export (Doc).
    const consumerTs = join(proj, "consumer.ts");
    writeFileSync(
      consumerTs,
      `import { documents, type Doc } from "@mindset-ai/db-schema";\n` +
        `export const table = documents;\n` +
        `export function firstTitle(rows: Doc[]): string | undefined { return rows[0]?.title; }\n`,
    );
    // Type-check with the consumer project's OWN tsc, resolving modules from
    // its node_modules — exactly as a real out-of-workspace consumer would.
    const tscBin = join(proj, "node_modules", ".bin", "tsc");
    const tsc = spawnSync(
      tscBin,
      ["--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "consumer.ts"],
      { cwd: proj, encoding: "utf8" },
    );
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
  });

  it("opens a Drizzle postgres connection and runs a query through the imported schema", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-11");

    const probe = join(proj, "probe.mjs");
    writeFileSync(
      probe,
      `import { drizzle } from "drizzle-orm/postgres-js";\n` +
        `import postgres from "postgres";\n` +
        `import { documents } from "@mindset-ai/db-schema";\n` +
        `const sql = postgres(process.env.DATABASE_URL, { max: 1 });\n` +
        `const db = drizzle(sql);\n` +
        `const rows = await db.select().from(documents).limit(1);\n` +
        `await sql.end();\n` +
        `process.stdout.write("QUERY_OK:" + Array.isArray(rows));\n`,
    );
    const run = spawnSync("node", [probe], { cwd: proj, env: { ...process.env, DATABASE_URL: TEST_URL }, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("QUERY_OK:true");
  });
});

describe("ac-5 — consuming is documented and demonstrably sufficient, incl. the RLS posture", () => {
  it("the README documents the install recipe, the drizzle usage, and the BYPASSRLS posture", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-5");
    const readme = readFileSync(join(PKG_DIR, "README.md"), "utf8");
    // Install recipe: scoped registry + GITHUB_TOKEN auth.
    expect(readme).toContain("@mindset-ai:registry=https://npm.pkg.github.com");
    expect(readme).toMatch(/GITHUB_TOKEN/);
    // Drizzle usage.
    expect(readme).toContain('from "@mindset-ai/db-schema"');
    expect(readme).toContain("drizzle(sql)");
    // The cross-tenant posture a consumer must understand.
    expect(readme).toMatch(/BYPASSRLS/);
    expect(readme).toMatch(/memex_admin/);
    expect(readme).toMatch(/admin.*schema|`admin`/);
  });
});
