// One-time test-database provisioning (see src/db/test-db-url.ts and std-9).
//
// Runs once in the main vitest process before any workers start:
//   1. derive the per-worktree test database URL (same derivation as the
//      vitest.config.ts `env` block, so workers connect to exactly this
//      database),
//   2. CREATE DATABASE if it doesn't exist yet,
//   3. run `pnpm db:migrate` against it (idempotent: drizzle journal +
//      manual_migrations table), so the schema always matches THIS
//      worktree's branch.
//
// If Postgres is unreachable we warn and skip instead of failing the run —
// `make test-unit` must keep working with no database at all; DB-backed
// suites will fail loudly on their own.
import "dotenv/config";
import { execSync } from "node:child_process";
import postgres from "postgres";
import { resolveTestDatabaseUrl } from "./src/db/test-db-url.js";

export default async function globalSetup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));

  // Admin connection on the maintenance DB — CREATE DATABASE can't run
  // inside the target database (it doesn't exist yet).
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });

  try {
    const existing =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (existing.length === 0) {
      console.log(`[test-db] creating database "${dbName}"`);
      // Identifier, not a value — quote by doubling, can't parameterise.
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } catch (err) {
    // 42P04 = duplicate_database: a concurrent run won the CREATE race; fine.
    if ((err as { code?: string }).code !== "42P04") {
      console.warn(
        `[test-db] skipping test-database setup (${(err as Error).message}). ` +
          `Unit tests are unaffected; DB-backed suites need Postgres running.`,
      );
      return;
    }
  } finally {
    await admin.end({ timeout: 1 });
  }

  console.log(`[test-db] tests run against "${dbName}" (dev database untouched)`);
  execSync("pnpm db:migrate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
