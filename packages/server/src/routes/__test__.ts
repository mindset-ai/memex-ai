// Test-only HTTP endpoints — mounted ONLY when MEMEX_ANTHROPIC_FAKE=1 is set. Lets an
// out-of-process test runner (Playwright) drive the Anthropic fake queue over HTTP.
//
// Never mount this in production. The env-flag check in app.ts is the only gate.

import { Hono } from "hono";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import {
  clearFakeQueue,
  enqueueFakeResponse,
  peekFakeQueueLength,
  type QueuedFakeResponse,
} from "../agent/anthropic-fake.js";
import { db } from "../db/connection.js";
import { users, namespaces, memexes, orgMemberships, orgs, documents } from "../db/schema.js";
import {
  getUserByEmail,
  upsertUserByEmail,
  updateUserProfile,
} from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createDocDraft } from "../services/documents.js";
import { mutate } from "../services/mutate.js";

const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);

const queueSchema = z.object({
  textDeltas: z.array(z.string()),
  content: z.array(contentBlockSchema),
  stopReason: z.enum(["end_turn", "tool_use", "max_tokens", "stop_sequence"]),
  deltaDelayMs: z.number().int().nonnegative().optional(),
});

export const testOnlyRouter = new Hono();

testOnlyRouter.post("/anthropic-queue", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = queueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.issues },
      400
    );
  }
  enqueueFakeResponse(parsed.data as QueuedFakeResponse);
  return c.json({ ok: true, queueLength: peekFakeQueueLength() });
});

testOnlyRouter.delete("/anthropic-queue", (c) => {
  clearFakeQueue();
  return c.json({ ok: true });
});

testOnlyRouter.get("/anthropic-queue", (c) =>
  c.json({ queueLength: peekFakeQueueLength() })
);

// ── e2e seed / read / cleanup surface (spec-172 dec-2) ───────────────────────
// The Playwright suite drives these over HTTP instead of writing raw SQL to the
// DB. Every mutation goes through the server's real services, so seeded rows
// emit on the unified bus [per std-8] and schema drift breaks the SERVER build
// loudly rather than rotting silently in the ui package (the failure mode that
// motivated the rebuild). Read-side and cleanup go through the same surface so
// no residual SQL lives in the e2e package.

// Resolve a user's personal memex (by email) → the slugs the path-based URL
// helpers build `/<ns>/<mx>/...` from, plus the memex id for seeding. Mirrors
// the old getPersonalMemexByEmail raw-SQL join, but reads the live schema.
testOnlyRouter.get("/personal-memex", async (c) => {
  const email = c.req.query("email");
  if (!email) return c.json({ error: "email query param required" }, 400);

  const user = await getUserByEmail(email);
  if (!user?.namespaceId) return c.json({ memex: null });

  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, user.namespaceId),
  });
  if (!ns) return c.json({ memex: null });

  const mx = await db.query.memexes.findFirst({
    where: eq(memexes.namespaceId, ns.id),
  });
  if (!mx) return c.json({ memex: null });

  return c.json({
    memex: { memexId: mx.id, namespaceSlug: ns.slug, memexSlug: mx.slug },
  });
});

// Ensure a user exists (upsert + lazy namespace/memex), used by globalSetup and
// the per-test fixture to guarantee dev@memex.ai is provisioned on a cold DB.
testOnlyRouter.post("/ensure-user", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ email: z.string().email() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const user = await upsertUserByEmail(parsed.data.email);
  if (!user.namespaceId) await ensureUserNamespace(user.id);
  return c.json({ ok: true, userId: user.id });
});

// Set (or clear) a user's display name. A non-empty name goes through
// updateUserProfile so the mutation emits on the bus [per std-8]; clearing the
// name (the onboarding journey's precondition) is a direct nulling because
// updateUserProfile rejects empty input by design.
const userNameSchema = z.object({
  email: z.string().email(),
  name: z.string().nullable(),
});
testOnlyRouter.post("/user-name", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = userNameSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { email, name } = parsed.data;
  const user = await getUserByEmail(email);
  if (!user) return c.json({ error: `User ${email} not found` }, 404);

  if (name === null || name.trim() === "") {
    await db
      .update(users)
      .set({ name: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  } else {
    await updateUserProfile(user.id, { name });
  }
  return c.json({ ok: true });
});

// Seed a Spec (documents row + first section) into a memex through the real
// createDocDraft service — so the bus emits a `document created` and the
// SSE-reactive UI sees it like any real Spec. The service mints the handle
// (`spec-N`); we return both the docId (for cleanup) and the handle (for the
// canonical path the journey navigates to).
const seedSpecSchema = z.object({
  memexId: z.string().uuid(),
  title: z.string(),
  purpose: z.string().optional(),
});
testOnlyRouter.post("/seed-spec", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, title, purpose = "Seeded purpose." } = parsed.data;
  const result = await createDocDraft(memexId, title, purpose, "spec");
  return c.json({ docId: result.id, handle: result.handle });
});

// Hard-delete a seeded doc (cascades to its sections via the FK). Used by the
// per-test afterEach so the dev memex is left clean between runs. Wrapped in
// mutate() so the deletion emits on the bus [per std-8].
testOnlyRouter.delete("/doc/:id", async (c) => {
  const docId = c.req.param("id");
  const existing = await db.query.documents.findFirst({
    where: eq(documents.id, docId),
  });
  if (!existing) return c.json({ ok: true, deleted: false });

  await mutate(
    {},
    { memexId: existing.memexId, docId, entity: "document", action: "deleted" },
    async () => {
      await db.delete(documents).where(eq(documents.id, docId));
      return {};
    },
  );
  return c.json({ ok: true, deleted: true });
});

// Reset a user's team-membership state — drops every org membership so a stale
// row from a prior run can't alter the switcher/router. The user's personal
// namespace is untouched (it is not an org membership). The schema-current
// equivalent of the old clearMembershipsForEmail.
testOnlyRouter.post("/clear-org-memberships", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ email: z.string().email() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const user = await getUserByEmail(parsed.data.email);
  if (!user) return c.json({ ok: true, cleared: 0 });
  const deleted = await db
    .delete(orgMemberships)
    .where(eq(orgMemberships.userId, user.id))
    .returning();
  return c.json({ ok: true, cleared: deleted.length });
});

// Tear down a namespace (and everything under it) that a test created. Accepts
// a namespace slug; deletes memexes → org memberships → orgs → the namespace,
// breaking the namespace↔org owner cycle first. Best-effort cleanup surface for
// the per-test resource tracker.
testOnlyRouter.post("/cleanup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      namespaceSlugs: z.array(z.string()).optional(),
      docIds: z.array(z.string().uuid()).optional(),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { namespaceSlugs = [], docIds = [] } = parsed.data;

  for (const docId of docIds) {
    await db.delete(documents).where(eq(documents.id, docId));
  }

  for (const slug of namespaceSlugs) {
    const ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.slug, slug),
    });
    if (!ns) continue;
    const memexIds = (
      await db.select({ id: memexes.id }).from(memexes).where(eq(memexes.namespaceId, ns.id))
    ).map((r) => r.id);
    for (const mxId of memexIds) {
      await db.delete(documents).where(eq(documents.memexId, mxId));
    }
    const orgIds = (
      await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.namespaceId, ns.id))
    ).map((r) => r.id);
    for (const orgId of orgIds) {
      await db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId));
    }
    await db.delete(memexes).where(eq(memexes.namespaceId, ns.id));
    // Break the namespace↔org owner cycle before deleting orgs.
    await db.update(namespaces).set({ ownerOrgId: null }).where(eq(namespaces.id, ns.id));
    await db.delete(orgs).where(eq(orgs.namespaceId, ns.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
  }

  return c.json({ ok: true });
});
