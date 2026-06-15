// spec-281 Fix 1 — the hand-migration applied-check is BATCHED: the script reads
// the applied set ONCE up front and compares in memory, instead of opening one
// psql process + DB connection per .sql file. On prod, where each connection rides
// cloud-sql-proxy at several× int's latency, the old per-file loop ballooned the
// migration phase to ~5m16s (observed 2026-06-13) even with nothing pending; this
// collapses ~105 connections to 1.
//
// Two layers of proof, mirroring the repo's split (deploy-wiring guards as static
// assertions + behaviour as a real-DB exercise):
//   • STATIC GUARD — fails if the per-file `WHERE filename = $tag` query is ever
//     reintroduced inside the collection loop, or the single up-front read removed
//     (covers ac-1's structure + ac-5's anti-regression guard).
//   • BEHAVIOURAL — runs the ACTUAL script against a throwaway local Postgres with
//     a psql-call-counting shim on PATH, proving (ac-1) the connection count is a
//     small constant regardless of how many files are on disk — the mechanism that
//     turns the prod migration phase from minutes to seconds (ac-3) — and (ac-2)
//     that journal files are excluded, applied files skipped, and a genuinely
//     pending file still applies its DDL + tracking INSERT in a single transaction.
//     Skips cleanly where `psql`/`python3` aren't on PATH (never a false failure).

import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-281";
const AC1 = `${SPEC}/acs/ac-1`;
const AC2 = `${SPEC}/acs/ac-2`;
const AC3 = `${SPEC}/acs/ac-3`;
const AC5 = `${SPEC}/acs/ac-5`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "packages", "server", "scripts", "apply-hand-migrations.sh");
const script = readFileSync(SCRIPT, "utf-8");

// The body of the collection `for f in "$DRIZZLE_DIR"/*.sql; do ... done` loop —
// the place the per-file connection used to live.
function collectionLoopBody(src: string): string {
  const start = src.indexOf('for f in "$DRIZZLE_DIR"/*.sql; do');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\ndone", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("spec-281 ac-1/ac-5: applied-check is read once up front, never per file (static guard)", () => {
  it("reads the whole applied set in a SINGLE up-front query before the loop", () => {
    tagAc(AC1);
    // One batched read: SELECT filename FROM manual_migrations (no WHERE/LIMIT per file).
    expect(script).toMatch(/APPLIED=\$\(psql\s+"\$DATABASE_URL"\s+-tAc\s+"SELECT filename FROM manual_migrations"\)/);
  });

  it("the collection loop contains NO psql call — membership is an in-memory grep", () => {
    tagAc(AC5);
    const body = collectionLoopBody(script);
    // The guard: a future edit that reintroduces a per-file DB round-trip fails here.
    expect(body).not.toMatch(/psql/);
    expect(body).not.toMatch(/SELECT 1 FROM manual_migrations WHERE filename/);
    // Skip already-applied via in-memory set membership against $APPLIED.
    expect(body).toMatch(/grep -qFx "\$tag" <<<"\$APPLIED"/);
  });

  it("preserves the journal-skip and the single-transaction apply + tracking insert (ac-2 structure)", () => {
    tagAc(AC2);
    expect(script).toMatch(/grep -qFx "\$tag" <<<"\$JOURNAL_TAGS"/); // drizzle-owned files excluded
    // genuinely-pending file: DDL + tracking INSERT in one --single-transaction psql.
    expect(script).toMatch(/--single-transaction[\s\S]*-f "\$f"[\s\S]*INSERT INTO manual_migrations/);
  });
});

// ── Behavioural: run the real script against a throwaway DB ──────────────────
function have(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const CAN_RUN = have("psql") && have("python3") && !!process.env.DATABASE_URL;

// Admin (maintenance) URL + a uniquely-named throwaway DB on the same host, so we
// never touch the per-worker ORM clone that DATABASE_URL points at.
function urls() {
  const u = new URL(process.env.DATABASE_URL!);
  const probeName = `memex_spec281_ac_${process.pid}`;
  const admin = new URL(u.toString());
  admin.pathname = "/postgres";
  const probe = new URL(u.toString());
  probe.pathname = `/${probeName}`;
  return { admin: admin.toString(), probe: probe.toString(), probeName };
}

describe.skipIf(!CAN_RUN)(
  "spec-281 ac-1/ac-2/ac-3: behaviour against a real throwaway Postgres",
  () => {
    const { admin, probe, probeName } = urls();
    let work = "";
    const shimCount = () => join(work, "count.txt");

    // Build a temp tree: copy of the real script + a fixture drizzle dir + a
    // psql shim that counts every invocation (connection) then execs real psql.
    function setup(handFileCount: number) {
      work = mkdtempSync(join(tmpdir(), "spec281-"));
      mkdirSync(join(work, "scripts"));
      mkdirSync(join(work, "drizzle", "meta"), { recursive: true });
      mkdirSync(join(work, "bin"));
      copyFileSync(SCRIPT, join(work, "scripts", "apply.sh"));

      // Journal: 0000..0008 are drizzle-owned (must be skipped without a DB hit).
      const entries = Array.from({ length: 9 }, (_, i) => ({
        idx: i,
        tag: `${String(i).padStart(4, "0")}_journal`,
      }));
      writeFileSync(
        join(work, "drizzle", "meta", "_journal.json"),
        JSON.stringify({ version: "7", dialect: "postgresql", entries }),
      );
      // journal files on disk + N hand-written files.
      for (let i = 0; i < 9; i++) {
        writeFileSync(join(work, "drizzle", `${String(i).padStart(4, "0")}_journal.sql`), "SELECT 1;\n");
      }
      for (let i = 1; i <= handFileCount; i++) {
        const n = 9000 + i;
        writeFileSync(join(work, "drizzle", `${n}_hand.sql`), `CREATE TABLE IF NOT EXISTS probe_${n}();\n`);
      }

      const realPsql = execFileSync("sh", ["-c", "command -v psql"], { encoding: "utf-8" }).trim();
      writeFileSync(
        join(work, "bin", "psql"),
        `#!/usr/bin/env bash\necho 1 >> "$PSQL_COUNT_FILE"\nexec "${realPsql}" "$@"\n`,
      );
      chmodSync(join(work, "bin", "psql"), 0o755);
    }

    // Run the copied script; return how many times psql (a DB connection) was opened.
    function run(mode: string[] = []): number {
      writeFileSync(shimCount(), "");
      execFileSync("bash", [join(work, "scripts", "apply.sh"), ...mode], {
        env: {
          ...process.env,
          PATH: `${join(work, "bin")}:${process.env.PATH}`,
          DATABASE_URL: probe,
          PSQL_COUNT_FILE: shimCount(),
        },
        stdio: "pipe",
      });
      return readFileSync(shimCount(), "utf-8").trim().split("\n").filter(Boolean).length;
    }

    function psqlAdmin(sql: string) {
      execFileSync("psql", [admin, "-v", "ON_ERROR_STOP=1", "-qc", sql], { stdio: "pipe" });
    }
    function psqlProbe(sql: string): string {
      return execFileSync("psql", [probe, "-tAc", sql], { encoding: "utf-8" }).trim();
    }

    function freshDb() {
      psqlAdmin(`DROP DATABASE IF EXISTS ${probeName} WITH (FORCE)`);
      psqlAdmin(`CREATE DATABASE ${probeName}`);
    }
    function teardown() {
      try {
        psqlAdmin(`DROP DATABASE IF EXISTS ${probeName} WITH (FORCE)`);
      } catch {
        /* best effort */
      }
      if (work) rmSync(work, { recursive: true, force: true });
    }

    it("ac-1/ac-3: connection count is a small constant — it does NOT scale with file count", () => {
      tagAc(AC1);
      tagAc(AC3);
      try {
        // 3 hand files, all already applied → 0 pending.
        freshDb();
        setup(3);
        run(["--seed"]); // mark all 3 as applied
        const small = run(); // count connections on the no-pending path
        teardown();

        // 30 hand files, all already applied → 0 pending.
        freshDb();
        setup(30);
        run(["--seed"]);
        const large = run();

        // The whole point: identical, tiny, independent of file count.
        // (1 CREATE-TABLE-IF-NOT-EXISTS + 1 batched applied-set read = 2.)
        expect(small).toBe(large);
        expect(small).toBeLessThanOrEqual(2);
      } finally {
        teardown();
      }
    });

    it("ac-2: journal excluded, applied skipped, pending applies DDL + tracking insert", () => {
      tagAc(AC2);
      try {
        freshDb();
        setup(2); // 9001_hand, 9002_hand pending; 0000..0008 journal on disk
        run(); // apply

        // Only the two hand-written tags are tracked — NO journal tags leaked in.
        const tracked = psqlProbe("SELECT filename FROM manual_migrations ORDER BY 1");
        expect(tracked.split("\n").filter(Boolean)).toEqual(["9001_hand", "9002_hand"]);

        // The pending file's DDL actually ran (probe table exists).
        expect(psqlProbe("SELECT count(*) FROM information_schema.tables WHERE table_name='probe_9001'")).toBe("1");

        // Re-run is a clean no-op — already-applied files are skipped.
        const out = execFileSync("bash", [join(work, "scripts", "apply.sh")], {
          env: { ...process.env, DATABASE_URL: probe },
          encoding: "utf-8",
        });
        expect(out).toMatch(/No hand-written migrations to apply\./);
      } finally {
        teardown();
      }
    });
  },
);
