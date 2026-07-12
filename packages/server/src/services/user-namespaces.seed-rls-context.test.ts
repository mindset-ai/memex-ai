// spec-436 regression: the provisioning seed path must run inside runWithMemexId(memexId)
// so the rlsClient proxy emits `set_config('app.memex_id', …)` and the `documents` RLS
// WITH CHECK policy passes. The runtime connects as the non-owner `memex_app` role, which is
// SUBJECT to RLS (std-36: ENABLE, never FORCE), so a seed INSERT without the tenant GUC is
// rejected ("new row violates row-level security policy for table \"documents\"") and the new
// personal Memex comes up EMPTY — the exact prod failure on revs 00083→00091.
//
// We assert the MECHANISM (the tenant context is active for the new memex while a seeder runs)
// rather than the DB outcome, because the test database may connect as the OWNER role that
// bypasses RLS (ENABLE-not-FORCE), which would mask the bug entirely — a real-DB "did the docs
// get seeded" assertion passes with OR without the fix. Asserting the GUC is host-independent:
// remove the runWithMemexId wrapper and the captured store is undefined → this fails.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";

const AC = "mindset-prod/memex-building-itself/specs/spec-436/acs";

// Capture holder, hoisted so the vi.mock factory below can close over it.
const cap = vi.hoisted(() => ({
  store: undefined as { memexId?: string; userId?: string } | undefined,
  calls: 0,
}));

// Mock the LAST seeder in seedNewPersonalMemex's allSettled. It always runs (the starter-spec +
// default-Standards seeders are gated OFF suite-wide by the vitest config), so it is a clean
// probe: whatever ALS context it observes is exactly the context the real seeders' INSERTs run
// under. The mock does no DB work, so the test stays isolated to the namespace/memex rows.
vi.mock("./default-facets.js", () => ({
  seedDefaultFacetsForMemexBestEffort: vi.fn(async () => {
    const { memexContext } = await import("../db/connection.js");
    cap.calls += 1;
    cap.store = memexContext.getStore();
  }),
}));

import { db } from "../db/connection.js";
import { namespaces, users } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(() => {
  // Keep the heavy seeders off (the default vitest posture) — only the mocked facets probe
  // runs, so this test neither writes demo/standards rows nor depends on RLS being enforced.
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "off";
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "off";
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

describe("spec-436 — provisioning seeds run under the new memex's tenant GUC", () => {
  it("seedNewPersonalMemex runs its seeders inside runWithMemexId(memexId) so app.memex_id is set", async () => {
    tagAc(`${AC}/ac-5`); // implementation: seeders run inside runWithMemexId(memexId)
    tagAc(`${AC}/ac-3`); // scope: tenant context via runWithMemexId, not a bypass role
    tagAc(`${AC}/ac-4`); // scope: regression guard — removing the wrapper fails CI

    const user = await upsertUserByEmail(
      `seed-rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    createdUserIds.push(user.id);

    const created = await ensureUserNamespace(user.id);
    const memexId = created.memex.id;

    const [ns] = await db
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(and(eq(namespaces.ownerUserId, user.id), eq(namespaces.kind, "user")))
      .limit(1);
    if (ns) createdNamespaceIds.push(ns.id);

    // The probe seeder ran, and it ran with the freshly-created memex's tenant context active —
    // i.e. every seed INSERT issued under this scope carries app.memex_id and satisfies RLS.
    expect(cap.calls).toBeGreaterThan(0);
    expect(cap.store?.memexId).toBe(memexId);
  });
});
