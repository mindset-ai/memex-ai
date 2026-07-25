// spec-184 t-3 / ac-9 — a default-Standards seed FAILURE never blocks signup: the
// user account + personal memex are still created and the seed error is logged, not
// surfaced. seedDefaultStandards is AWAITED inside ensureUserNamespace, wrapped in a
// try/catch (`await seedDefaultStandards(memexId)` → caught + logged) — it used to be
// detached, but the detached post-response promise was starved on Cloud Run, so it was
// moved onto the request path. Mocking it to reject exercises the exact catch branch ac-9
// protects. This ALSO guards the wiring: if the hook were dropped the mock would never be
// called, the seed error would never be logged, and this test would fail.
//
// Runs against REAL Postgres (the namespace + memex are really created); only the seeder
// is mocked. spec-509 dec-2 deleted the starter-spec seeder that used to share this
// best-effort hook, so there is no second seeder to stub out — the default-Standards seed
// is now the only content seeder on the provisioning path, which makes this suite the sole
// remaining proof that a seeder rejection is caught and logged rather than propagating
// (spec-509 ac-15's best-effort half).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const { seedError } = vi.hoisted(() => ({
  seedError: new Error("default-standards seed boom (spec-184 ac-9 resilience test)"),
}));
vi.mock("./default-standards.js", () => ({
  seedDefaultStandards: vi.fn().mockRejectedValue(seedError),
}));

import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import { ensureUserNamespace, provisionUserMemex } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-184/acs/ac-${n}`;

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

// spec-186: the vitest config disables the signup seed hook suite-wide; this suite
// tests the hook's failure resilience, so opt back in (the gate reads env at call time).
beforeAll(() => {
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "off";
});

afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("provisioning — a default-Standards seed failure never blocks the flow (ac-9)", () => {
  it("creates the namespace + memex on signup, and provisionUserMemex resolves + logs the seed error", async () => {
    tagAc(AC(9));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await upsertUserByEmail(
      `ds184-seedfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    createdUserIds.push(user.id);

    // spec-474 dec-6: signup only creates the namespace + memex (no content seed), so
    // ensureUserNamespace resolves regardless of any seeder health.
    await expect(ensureUserNamespace(user.id)).resolves.toBeDefined();

    // The account artifacts exist: a personal (kind='user') namespace + its memex.
    const [ns] = await db
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(and(eq(namespaces.ownerUserId, user.id), eq(namespaces.kind, "user")))
      .limit(1);
    expect(ns).toBeDefined();
    createdNamespaceIds.push(ns.id);
    const [mx] = await db
      .select({ id: memexes.id })
      .from(memexes)
      .where(eq(memexes.namespaceId, ns.id))
      .limit(1);
    expect(mx).toBeDefined();

    // The content seed runs on the readiness step. The Standards seed is mocked to reject;
    // provisionUserMemex must still RESOLVE (best-effort per-seed try/catch) and log the
    // error — which also proves the seeder hook actually fired.
    await expect(provisionUserMemex(user.id)).resolves.toBeDefined();

    expect(errSpy).toHaveBeenCalled();
    const loggedTheSeedError = errSpy.mock.calls.some((args) =>
      args.some((arg) => arg === seedError),
    );
    expect(loggedTheSeedError).toBe(true);

    errSpy.mockRestore();
  });
});
