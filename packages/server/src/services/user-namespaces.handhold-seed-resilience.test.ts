// issue-3 / t-14 (H3): ac-7 promises that a demo-seed FAILURE never blocks signup —
// "the user account and personal memex are still created, and the seeding error is
// logged rather than surfaced to the user." The pre-existing ac-7 tests only exercised
// the SUCCESS path (seed lands 5 / org seeds 0), so the resilience the AC exists to
// guarantee was unverified: a regression that let a seed error propagate out of
// ensureUserNamespace (dropping the `.catch`, or awaiting the seed) would have passed
// every tagged test. This drives the FAILURE path directly.
//
// seedHandholdDemo is fired as a detached best-effort step inside ensureUserNamespace
// (`void seedHandholdDemo(memexId).catch(...)`), so mocking it to reject exercises the
// exact catch branch ac-7 protects. Runs against REAL Postgres (the namespace + memex
// are really created); only the demo seeder is mocked.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

// Mock the demo seeder to always reject. vi.mock is hoisted and keys on the module
// path; ensureUserNamespace imports `seedHandholdDemo` from this same module, so its
// import resolves to this mock. The rejection value is created via vi.hoisted (also
// hoisted) — a plain top-level const would be in the temporal dead zone when the
// hoisted mock factory executes at import time.
const { seedError } = vi.hoisted(() => ({
  seedError: new Error("handhold seed boom (issue-3 resilience test)"),
}));
vi.mock("./handhold-demo.js", () => ({
  seedHandholdDemo: vi.fn().mockRejectedValue(seedError),
}));

import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-178/acs/ac-${n}`;

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

// spec-186: the vitest config disables the signup seed hook suite-wide; this
// suite tests the hook's failure resilience, so opt back in (call-time read).
beforeAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "off";
});

afterAll(async () => {
  // Namespaces cascade to their memex; users last.
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

describe("ensureUserNamespace — a demo-seed failure never blocks signup (ac-7 / ac-41)", () => {
  it("still creates the user's namespace + personal memex, resolves, and logs the seed error when seeding throws", async () => {
    tagAc(AC(7));
    tagAc(AC(41));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await upsertUserByEmail(
      `h178-seedfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    createdUserIds.push(user.id);

    // The seed is mocked to reject; ensureUserNamespace must still RESOLVE (the seed
    // is post-commit + best-effort, so a seed failure can never block signup).
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

    // The detached best-effort seed rejects on a microtask after the call returns;
    // give it a tick, then assert the error was logged (swallowed, not surfaced).
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy).toHaveBeenCalled();
    const loggedTheSeedError = errSpy.mock.calls.some((args) =>
      args.some((arg) => arg === seedError),
    );
    expect(loggedTheSeedError).toBe(true);

    errSpy.mockRestore();
  });
});
