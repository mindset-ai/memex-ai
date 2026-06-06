// spec-184 t-3 / ac-9 — a default-Standards seed FAILURE never blocks signup: the
// user account + personal memex are still created and the seed error is logged, not
// surfaced. seedDefaultStandards is fired as a detached best-effort step inside
// ensureUserNamespace (`void seedDefaultStandards(memexId).catch(...)`), so mocking it
// to reject exercises the exact catch branch ac-9 protects. This ALSO guards the
// wiring: if the hook were dropped the mock would never be called, the seed error would
// never be logged, and this test would fail.
//
// Runs against REAL Postgres (the namespace + memex are really created); only the
// seeders are mocked. The handhold seed shares the same best-effort hook, so it's
// stubbed to a no-op to isolate the failure to the default-Standards path.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const { seedError } = vi.hoisted(() => ({
  seedError: new Error("default-standards seed boom (spec-184 ac-9 resilience test)"),
}));
vi.mock("./handhold-demo.js", () => ({
  seedHandholdDemo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./default-standards.js", () => ({
  seedDefaultStandards: vi.fn().mockRejectedValue(seedError),
}));

import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
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

describe("ensureUserNamespace — a default-Standards seed failure never blocks signup (ac-9)", () => {
  it("still creates the user's namespace + personal memex, resolves, and logs the seed error", async () => {
    tagAc(AC(9));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await upsertUserByEmail(
      `ds184-seedfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    createdUserIds.push(user.id);

    // The seed is mocked to reject; ensureUserNamespace must still RESOLVE (the seed is
    // post-commit + best-effort, so a seed failure can never block signup).
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

    // The detached best-effort seed rejects on a microtask after the call returns; give
    // it a tick, then assert the error was logged (swallowed, not surfaced) — which also
    // proves the hook actually fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy).toHaveBeenCalled();
    const loggedTheSeedError = errSpy.mock.calls.some((args) =>
      args.some((arg) => arg === seedError),
    );
    expect(loggedTheSeedError).toBe(true);

    errSpy.mockRestore();
  });
});
