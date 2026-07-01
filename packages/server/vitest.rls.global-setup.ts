// Global setup for the RESTRICTED-ROLE RLS test project (spec-440 dec-1).
//
// Runs once, in the main process, before any RLS worker starts. It:
//   1. reuses the default global-setup — create the per-worktree test DB, run
//      migrations, and clone one DB per worker slot (identical provisioning, so
//      the RLS project sees the same freshly-migrated schema as the main suite);
//   2. enables LOGIN on the `memex_app` role with a fixed test password, in the
//      TEST cluster only. `memex_app` is created NOLOGIN by migration 0081 (prod
//      grants login via a deploy secret); the RLS worker setup then connects the
//      singleton AS `memex_app` so every gated-table write is subject to RLS.
//
// This role change is cluster-global but confined to the local/CI test cluster,
// and it does NOT alter the attributes the memex_app role tests assert
// (NOSUPERUSER / NOBYPASSRLS / NOCREATEROLE / NOCREATEDB) — only LOGIN + password.
import "dotenv/config";
import postgres from "postgres";
import defaultGlobalSetup from "./vitest.global-setup.js";
import {
  RLS_TEST_ROLE,
  RLS_TEST_ROLE_PASSWORD,
  resolveTestDatabaseUrl,
} from "./src/db/test-db-url.js";

export default async function rlsGlobalSetup(): Promise<void> {
  // 1. Provision DB + per-worker clones exactly as the main suite does.
  await defaultGlobalSetup();

  // 2. Make memex_app loginable in the test cluster so the singleton can connect
  //    AS it. Connect as the owner (the resolved test URL's default credentials).
  const ownerUrl = resolveTestDatabaseUrl();
  const admin = postgres(ownerUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    // Identifier is a fixed literal; the password is a fixed test constant. ALTER
    // ROLE can't be parameterised, so both are inlined — neither is user input.
    await admin.unsafe(
      `ALTER ROLE ${RLS_TEST_ROLE} WITH LOGIN PASSWORD '${RLS_TEST_ROLE_PASSWORD}'`,
    );
    console.log(
      `[rls-test] enabled LOGIN on "${RLS_TEST_ROLE}" (test cluster only) — ` +
        `the RLS suite connects the singleton as this RLS-subject role`,
    );
  } catch (err) {
    console.warn(
      `[rls-test] could not enable LOGIN on ${RLS_TEST_ROLE} (${(err as Error).message}). ` +
        `The RLS suite will fail to connect; the main suite is unaffected.`,
    );
  } finally {
    await admin.end({ timeout: 1 });
  }
}
