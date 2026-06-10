// Integration tests for the handhold onboarding demo (spec-178).
//
//   t-4 signup hook  — ensureUserNamespace() seeds 5 is_demo Specs into a fresh
//                      user's personal Memex (ac-6: seeding runs only for kind='user'
//                      memexes; creating an org/team memex seeds none). ac-7 (a seed
//                      FAILURE never blocks signup) is the resilience guarantee — it is
//                      exercised by user-namespaces.handhold-seed-resilience.test.ts,
//                      which mocks the seeder to reject. The success-path cases below
//                      assert ac-6 (personal-only seeding), not ac-7.
//   t-6 reset route  — POST /api/:namespace/:memex/handhold/reset is gated to the
//                      personal owner (std-7 404 for a non-owner / non-personal
//                      target, no mutation) and, for the owner, returns 200 and
//                      leaves exactly 5 is_demo Specs (ac-17).
//
// These run against a REAL Postgres through the full Hono app + middleware
// stack (memexResolver → sessionMiddleware → owner gate → resetHandholdDemo).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors issues-list.integration.test.ts). Without GOOGLE_CLIENT_ID set the
  // middleware falls into dev-mode and authenticates everyone as dev@memex.ai,
  // which would defeat the non-owner 404 assertion.
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { documents, namespaces, memexes, users } from "../db/schema.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { resetHandholdDemo } from "../services/handhold-demo.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { HANDHOLD_PHASES } from "../db/handhold-demo.fixture.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-178/acs/ac-${n}`;

// Users / namespaces we mint, torn down at the end. Deleting the namespace
// cascades to its memex + documents; deleting the user cascades the rest.
const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// Count the is_demo Specs in a Memex (the read paths the demo cares about).
async function countDemoDocs(memexId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  return rows.length;
}

// The signup seed is fire-and-forget (a detached promise in ensureUserNamespace),
// so poll until the demo docs land rather than asserting synchronously.
async function waitForDemoDocs(
  memexId: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await countDemoDocs(memexId);
    if (last >= expected) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

// Resolve the personal namespace + memex a user owns (created by ensureUserNamespace).
async function personalOf(userId: string): Promise<{
  namespaceSlug: string;
  memexSlug: string;
  memexId: string;
  namespaceId: string;
}> {
  const [ns] = await db
    .select({ id: namespaces.id, slug: namespaces.slug })
    .from(namespaces)
    .where(and(eq(namespaces.ownerUserId, userId), eq(namespaces.kind, "user")))
    .limit(1);
  const [mx] = await db
    .select({ id: memexes.id, slug: memexes.slug })
    .from(memexes)
    .where(eq(memexes.namespaceId, ns.id))
    .limit(1);
  return {
    namespaceSlug: ns.slug,
    memexSlug: mx.slug,
    memexId: mx.id,
    namespaceId: ns.id,
  };
}

async function makePersonalUser(prefix: string): Promise<{
  userId: string;
  bearer: string;
  namespaceSlug: string;
  memexSlug: string;
  memexId: string;
}> {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  await ensureUserNamespace(user.id);
  const p = await personalOf(user.id);
  createdNamespaceIds.push(p.namespaceId);
  return {
    userId: user.id,
    bearer: signSessionToken(user.id),
    namespaceSlug: p.namespaceSlug,
    memexSlug: p.memexSlug,
    memexId: p.memexId,
  };
}

// spec-186: the vitest config disables the signup seed hook suite-wide (its
// detached promise races other tests' cleanup). THIS suite tests the hook
// itself, so opt back in — the gate reads process.env at call time.
beforeAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "off";
});

afterAll(async () => {
  // Namespaces cascade to memex + documents; do those first, then the users.
  if (createdNamespaceIds.length > 0) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

function reset(
  namespaceSlug: string,
  memexSlug: string,
  bearer: string,
): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", "memex.ai");
  headers.set("Authorization", `Bearer ${bearer}`);
  return Promise.resolve(
    app.request(`/api/${namespaceSlug}/${memexSlug}/handhold/reset`, {
      method: "POST",
      headers,
    }),
  );
}

describe("spec-178 t-4 — signup seed hook (ac-6 / ac-7)", () => {
  it("ensureUserNamespace seeds 5 is_demo Specs into a fresh user's personal Memex", async () => {
    tagAc(AC(6));
    tagAc(AC(1)); // scope ac-1: a new personal Memex auto-contains 5 demo Specs, no manual setup
    const user = await makePersonalUser("h178-signup");
    const count = await waitForDemoDocs(user.memexId, HANDHOLD_PHASES.length);
    expect(count).toBe(HANDHOLD_PHASES.length);
    expect(HANDHOLD_PHASES.length).toBe(5);
  });

  it("org / team Memex creation seeds NO demo Specs (the demo is personal-only)", async () => {
    tagAc(AC(6));
    // makeTestMemexWithDevAdmin builds a kind:'org' namespace + memex — the
    // signup hook never runs for it, so it must carry zero demo docs.
    const made = await makeTestMemexWithDevAdmin("h178-org");
    createdNamespaceIds.push(
      (
        await db
          .select({ id: namespaces.id })
          .from(namespaces)
          .where(eq(namespaces.slug, made.slug))
          .limit(1)
      )[0].id,
    );
    // Give any (incorrectly-wired) async seed a moment; it must still be zero.
    await new Promise((r) => setTimeout(r, 300));
    expect(await countDemoDocs(made.memexId)).toBe(0);
  });
});

describe("spec-178 t-6 — reset route owner gate (ac-17)", () => {
  it("the personal owner gets 200 and exactly 5 is_demo Specs after reset", async () => {
    tagAc(AC(17));
    const owner = await makePersonalUser("h178-owner");
    // Let the signup seed settle so reset exercises the delete+reseed path, not
    // a cold seed.
    await waitForDemoDocs(owner.memexId, HANDHOLD_PHASES.length);

    const res = await reset(owner.namespaceSlug, owner.memexSlug, owner.bearer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; seeded: number };
    expect(body.status).toBe("ok");
    expect(body.seeded).toBe(HANDHOLD_PHASES.length);
    // resetHandholdDemo is awaited in the handler, so the count is final on return.
    expect(await countDemoDocs(owner.memexId)).toBe(HANDHOLD_PHASES.length);
  });

  it("a non-owner with a valid token gets 404 (not 403) and no mutation runs", async () => {
    tagAc(AC(17));
    const owner = await makePersonalUser("h178-victim");
    await waitForDemoDocs(owner.memexId, HANDHOLD_PHASES.length);
    const before = await countDemoDocs(owner.memexId);

    const stranger = await upsertUserByEmail(uniqueEmail("h178-stranger"));
    createdUserIds.push(stranger.id);
    const strangerBearer = signSessionToken(stranger.id);

    const res = await reset(owner.namespaceSlug, owner.memexSlug, strangerBearer);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    // No mutation: the demo doc set is untouched.
    expect(await countDemoDocs(owner.memexId)).toBe(before);
  });

  it("a non-personal (org) Memex returns 404 even for an org member", async () => {
    tagAc(AC(17));
    // dev@memex.ai is enrolled as administrator member of this org memex.
    const made = await makeTestMemexWithDevAdmin("h178-orggate");
    createdNamespaceIds.push(
      (
        await db
          .select({ id: namespaces.id })
          .from(namespaces)
          .where(eq(namespaces.slug, made.slug))
          .limit(1)
      )[0].id,
    );
    const dev = await upsertUserByEmail("dev@memex.ai");
    const devBearer = signSessionToken(dev.id);

    const res = await reset(made.slug, "main", devBearer);
    // namespace.kind === 'org' → std-7 404, never 403, no seed/mutation.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(await countDemoDocs(made.memexId)).toBe(0);
  });

  it("an anonymous request is rejected before the handler (401, no mutation)", async () => {
    tagAc(AC(17));
    const owner = await makePersonalUser("h178-anon");
    await waitForDemoDocs(owner.memexId, HANDHOLD_PHASES.length);
    const before = await countDemoDocs(owner.memexId);

    const headers = new Headers();
    headers.set("Host", "memex.ai");
    const res = await app.request(
      `/api/${owner.namespaceSlug}/${owner.memexSlug}/handhold/reset`,
      { method: "POST", headers },
    );
    // STRICT sessionMiddleware: no Bearer → 401 (write never reachable anonymously).
    expect(res.status).toBe(401);
    expect(await countDemoDocs(owner.memexId)).toBe(before);
  });

  it("an unknown namespace/memex returns 404", async () => {
    tagAc(AC(17));
    const owner = await makePersonalUser("h178-unknown");
    const res = await reset(
      `no-such-namespace-${Date.now()}`,
      "nope",
      owner.bearer,
    );
    expect(res.status).toBe(404);
  });
});

// Direct service-level guard so the reset count contract is pinned independent of
// the HTTP layer (defense in depth for ac-17's "exactly 5" clause).
describe("spec-178 t-6 — resetHandholdDemo service contract (ac-17)", () => {
  it("reset returns { seeded: 5 } and leaves exactly 5 is_demo Specs", async () => {
    tagAc(AC(17));
    const owner = await makePersonalUser("h178-svc");
    await waitForDemoDocs(owner.memexId, HANDHOLD_PHASES.length);
    const result = await resetHandholdDemo(owner.memexId);
    expect(result.seeded).toBe(HANDHOLD_PHASES.length);
    expect(await countDemoDocs(owner.memexId)).toBe(HANDHOLD_PHASES.length);
  }, 20_000);
});
