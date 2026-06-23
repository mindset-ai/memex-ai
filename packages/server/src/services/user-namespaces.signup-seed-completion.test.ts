// Regression: the signup onboarding seed must COMPLETE before ensureUserNamespace
// resolves — i.e. it is awaited, not fire-and-forget.
//
// The bug this guards: the handhold demo (spec-178) + default Standards (spec-184) seeds
// were originally detached (`void seed…()`) and run AFTER the HTTP response flushed. On
// Cloud Run, CPU is throttled to ~0 once the response is sent, so those post-response
// multi-insert promises were starved/killed before committing — new users (seen on PROD
// with HealthStream sign-ups, 2026-06) landed in an EMPTY personal Memex: no demo spec,
// no Standards. The fix awaits both seeds inside ensureUserNamespace, on the request path,
// where CPU is allocated.
//
// This test asserts the seeded rows exist the INSTANT ensureUserNamespace resolves, with
// NO tick / setTimeout to let a detached promise settle. Under the old fire-and-forget code
// the rows would not be present yet and this fails; under the awaited fix it is deterministic.
// Runs against REAL Postgres (the rows are really inserted).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, memexes, users, documents } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { DEFAULT_STANDARDS_COUNT } from "../db/default-standards.fixture.js";

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

// spec-186: the vitest config disables both signup-seed hooks suite-wide; this suite is
// specifically verifying that they fire + complete, so opt back in (read at CALL time).
beforeAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "on";
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "off";
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "off";
});

afterAll(async () => {
  // Namespaces cascade to their memex + docs; users last.
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("ensureUserNamespace — onboarding seed completes before it resolves (not fire-and-forget)", () => {
  it("a brand-new personal Memex already holds the demo spec + all default Standards the instant ensureUserNamespace resolves — no tick", async () => {
    const user = await upsertUserByEmail(
      `seed-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    createdUserIds.push(user.id);

    const created = await ensureUserNamespace(user.id);
    const memexId = created.memex.id;

    // Track for cleanup.
    const [ns] = await db
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(and(eq(namespaces.ownerUserId, user.id), eq(namespaces.kind, "user")))
      .limit(1);
    if (ns) createdNamespaceIds.push(ns.id);

    // NO setTimeout / tick here — the assertion is the point: the rows are committed by the
    // time ensureUserNamespace resolves, proving the seeds were awaited.
    const docs = await db
      .select({ id: documents.id, docType: documents.docType, isDemo: documents.isDemo })
      .from(documents)
      .where(eq(documents.memexId, memexId));

    const demoDocs = docs.filter((d) => d.isDemo);
    const standards = docs.filter((d) => d.docType === "standard");

    expect(demoDocs.length).toBeGreaterThan(0);
    expect(standards.length).toBe(DEFAULT_STANDARDS_COUNT);
  });
});
