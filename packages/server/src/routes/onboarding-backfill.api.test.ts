// spec-213 t-1 — backfill onboarding_greeted_at for pre-existing users.
//
// spec-206 gates the first-run greeting on `onboarding_greeted_at IS NULL`, but its
// schema migration (0082) left the column null for the entire pre-existing user
// base — so every existing user reads as eligible. Migration 0083 corrects the DATA
// (not the gate): it stamps every still-null row at deploy time.
//
//   ac-5 — 0083 issues the canonical guarded UPDATE (SET ... = now() WHERE ... IS NULL).
//   ac-6 — a backfilled (now non-null) user returns greet=false from the gate.
//   ac-7 — a user still null after the backfill (a new signup) returns greet=true.
//   ac-8 — the backfill is idempotent: a row already carrying a timestamp is untouched.
//
// The behavioural tests run the migration's ACTUAL UPDATE statement (read from the
// .sql file) but SCOPED to the user ids this test creates (`AND id IN (...)`). The
// real migration is unbounded by design; scoping here keeps it from stamping users
// that parallel test files (e.g. onboarding.api.test.ts) create and expect to stay
// null. The unbounded form itself is asserted statically against the file (ac-5).
//
// Runs against a REAL Postgres through the full Hono app + strict sessionMiddleware.

import { describe, it, expect, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inArray, sql } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors onboarding.api.test.ts). Without GOOGLE_CLIENT_ID the middleware
  // falls into dev-mode and authenticates everyone as dev@memex.ai.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users } from "../db/schema.js";
import { upsertUserByEmail, getUserById } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-213/acs/ac-${n}`;

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle/0083_backfill_users_onboarding_greeted_at.sql",
);

const createdUserIds: string[] = [];

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function makeUser(prefix: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  return { id: user.id, bearer: signSessionToken(user.id) };
}

async function greet(bearer: string): Promise<boolean> {
  const res = await app.request("/api/onboarding/greeting", {
    headers: new Headers({ Authorization: `Bearer ${bearer}` }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).greet;
}

/** The exact UPDATE statement from the migration file, comments stripped and the
 *  trailing `;` removed — so the behavioural tests run the real migration SQL. */
function migrationUpdateStatement(): string {
  const raw = readFileSync(MIGRATION_PATH, "utf8");
  const sqlOnly = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  return sqlOnly.replace(/;\s*$/, "");
}

/** Run the migration's UPDATE, scoped to the given ids so it can't touch rows
 *  other test files own. The ids are test-minted UUIDs, never user input. */
async function runScopedBackfill(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const idList = ids.map((id) => `'${id}'`).join(", ");
  await db.execute(
    sql.raw(`${migrationUpdateStatement()} AND id IN (${idList})`),
  );
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("onboarding_greeted_at backfill (spec-213 t-1)", () => {
  it("the migration issues the canonical guarded UPDATE (SET = now() WHERE IS NULL)", () => {
    tagAc(AC(5));
    const stmt = migrationUpdateStatement().replace(/\s+/g, " ").toLowerCase();
    expect(stmt).toContain("update users");
    expect(stmt).toContain("set onboarding_greeted_at = now()");
    expect(stmt).toContain("where onboarding_greeted_at is null");
    // No id/email predicate in the real migration — it stamps the whole null set.
    expect(stmt).not.toContain(" id in (");
    expect(stmt).not.toContain("where id");
  });

  it("a pre-existing (null) user is stamped by the backfill → greet=false", async () => {
    tagAc(AC(6));
    const u = await makeUser("sp213-existing");
    // Pre-existing user: null flag, so the gate would greet them.
    expect((await getUserById(u.id))!.onboardingGreetedAt).toBeNull();
    expect(await greet(u.bearer)).toBe(true);

    await runScopedBackfill([u.id]);

    // After the backfill they carry a timestamp and are no longer greeted.
    expect((await getUserById(u.id))!.onboardingGreetedAt).toBeInstanceOf(Date);
    expect(await greet(u.bearer)).toBe(false);
  });

  it("a user created after the backfill is still null → greet=true (new signups preserved)", async () => {
    tagAc(AC(7));
    // Model a backfill that has already run over the existing population...
    const existing = await makeUser("sp213-before");
    await runScopedBackfill([existing.id]);
    expect((await getUserById(existing.id))!.onboardingGreetedAt).toBeInstanceOf(Date);

    // ...then a brand-new signup arrives. It was NOT in the backfill set, so its
    // flag is null and the spec-206 first-run greeting still fires for it.
    const newcomer = await makeUser("sp213-newcomer");
    expect((await getUserById(newcomer.id))!.onboardingGreetedAt).toBeNull();
    expect(await greet(newcomer.bearer)).toBe(true);
  });

  it("is idempotent — a row already stamped is not overwritten", async () => {
    tagAc(AC(8));
    const u = await makeUser("sp213-idem");

    // First backfill stamps it.
    await runScopedBackfill([u.id]);
    const firstTs = (await getUserById(u.id))!.onboardingGreetedAt;
    expect(firstTs).toBeInstanceOf(Date);

    // Re-running the (guarded) backfill leaves the existing timestamp untouched —
    // the WHERE ... IS NULL clause skips already-stamped rows, so a genuinely
    // greeted user is never re-stamped.
    await runScopedBackfill([u.id]);
    const secondTs = (await getUserById(u.id))!.onboardingGreetedAt;
    expect(secondTs!.getTime()).toBe(firstTs!.getTime());
  });
});
