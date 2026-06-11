// Test-only HTTP endpoints — mounted ONLY when MEMEX_ANTHROPIC_FAKE=1 is set. Lets an
// out-of-process test runner (Playwright) drive the Anthropic fake queue over HTTP.
//
// Never mount this in production. The env-flag check in app.ts is the only gate.

import { Hono } from "hono";
import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import {
  clearFakeQueue,
  enqueueFakeResponse,
  peekFakeQueueLength,
  type QueuedFakeResponse,
} from "../agent/anthropic-fake.js";
import { db } from "../db/connection.js";
import { users, namespaces, memexes, orgMemberships, orgs, documents, decisions, whatsNewEntries } from "../db/schema.js";
import {
  getUserByEmail,
  upsertUserByEmail,
  updateUserProfile,
  markEmailVerified,
  markOnboardingGreeted,
  createUserWithPassword,
} from "../services/users.js";
import { ensureUserNamespace, ensureUserMemex } from "../services/user-namespaces.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { markNarrativeConsolidated } from "../services/narrative.js";
import { publishEntry } from "../services/whats-new.js";
import { createDecision } from "../services/decisions.js";
import { hashPassword } from "../services/passwords.js";
import { issueAuthToken } from "../services/auth-tokens.js";
import { mutate } from "../services/mutate.js";
import { createOrgWithMemexForUser } from "../services/__test__/seed-org.js";
import { mintEmissionKey, mintEphemeralEmissionKey } from "../services/emission-keys.js";
import { updateOrgSettings } from "../services/orgs.js";
import { createInviteToken } from "../services/invite-tokens.js";
import { createDomainVerificationToken } from "../services/domain-verification.js";
import { upsertVerifiedDomain } from "../services/verified-domains.js";
// spec-172 t-5: additive seed/read surface for the retained journeys (5, 11, 12).
import { createTask } from "../services/tasks.js";
// spec-188 t-5: seed surface for the verify-phase journey (ACs, issues,
// test-event emissions for the acceptance-precedence path).
import { createAc, buildAcRef } from "../services/acs.js";
import { createIssue } from "../services/issues.js";
import { testEvents } from "../db/schema.js";
import { applyEmissionToSummary } from "../services/test-event-latest.js";
import { createExecutionPlan } from "../services/execution_plans.js";
import { addTaskComment } from "../services/comments.js";
import { createShareToken, listShareTokensForDoc } from "../services/share-tokens.js";
import { addSection } from "../services/sections.js";
import { resolveRole } from "../services/doc-members.js";
import { listAssignees, assign } from "../services/doc-assignees.js";
import { updateMemexVisibility } from "../services/memexes.js";
import { disableMembership } from "../services/org-memberships.js";
import { persistEvent } from "../services/activity-log.js";

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

// spec-206 t-5: set/clear a user's first-run greeting flag. The onboarding journey
// un-greets the dev user to drive the auto-greeting deterministically; the per-test
// fixture + globalSetup pre-stamp it greeted so the auto-greeting never surprises
// OTHER journeys (it would otherwise fire on the shared dev user's first board load
// wherever a mic is available). greeted=true uses the real service; greeted=false
// is a direct nulling (un-greeting exists only for tests).
const onboardingGreetedSchema = z.object({
  email: z.string().email(),
  greeted: z.boolean(),
});
testOnlyRouter.post("/onboarding-greeted", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = onboardingGreetedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { email, greeted } = parsed.data;
  const user = await getUserByEmail(email);
  if (!user) return c.json({ error: `User ${email} not found` }, 404);

  if (greeted) {
    await markOnboardingGreeted(user.id);
  } else {
    await db
      .update(users)
      .set({ onboardingGreetedAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
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
  createdByUserId: z.string().uuid().optional(),
});
testOnlyRouter.post("/seed-spec", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedSpecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, title, purpose = "Seeded purpose.", createdByUserId } = parsed.data;
  const result = await createDocDraft(memexId, title, purpose, "spec", undefined, undefined, createdByUserId);
  // The first (overview/purpose) section id — handy for journeys that mutate a
  // section over the API (e.g. the reactivity round-trips in journey-16).
  return c.json({ docId: result.id, handle: result.handle, sectionId: result.sections[0]?.id ?? null });
});

// spec-200 t-3/journey-22: seed a published What's New entry into the global feed
// (the env-gated equivalent of the deploy-time generation step). Idempotent on
// sourceSpecRef, like the real generation path.
const seedWhatsNewSchema = z.object({
  sourceSpecRef: z.string(),
  sourceSpecHandle: z.string(),
  title: z.string(),
  whatText: z.string(),
  whyText: z.string(),
});
testOnlyRouter.post("/seed-whats-new", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedWhatsNewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const entry = await publishEntry(parsed.data);
  return c.json({ id: entry?.id ?? null });
});

// spec-200 journey-22: clear the global What's New feed so a seeded entry can't
// leak into other journeys (the feed is global, and each test gets a fresh
// browser context with no dismiss marker → the ribbon would otherwise show
// everywhere). Test-only truncate.
testOnlyRouter.delete("/whats-new", async (c) => {
  await db.delete(whatsNewEntries);
  return c.json({ ok: true });
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

// Resolve a memex id from a (namespaceSlug, memexSlug) pair — the lifecycle-
// spine journey (t-7 / ac-13) creates its org + memex through the real UI, which
// only hands back slugs, but seed-spec / seed-open-decision are keyed by memexId.
// This is the slug→id lookup that bridges the two (no email key, unlike
// /personal-memex). Reads the live schema; returns null when either slug misses.
testOnlyRouter.get("/resolve-memex", async (c) => {
  const namespaceSlug = c.req.query("namespaceSlug");
  const memexSlug = c.req.query("memexSlug");
  if (!namespaceSlug || !memexSlug) {
    return c.json({ error: "namespaceSlug and memexSlug query params required" }, 400);
  }
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, namespaceSlug),
  });
  if (!ns) return c.json({ memexId: null });
  const mx = await db.query.memexes.findFirst({
    where: and(eq(memexes.namespaceId, ns.id), eq(memexes.slug, memexSlug)),
  });
  return c.json({ memexId: mx?.id ?? null });
});

// Seed an OPEN decision (with structured options) onto a doc through the real
// createDecision service — so the bus emits `decision created` and the
// SSE-reactive DecisionPanel sees it like any agent-proposed-then-approved
// decision. createDecision writes status='open' but leaves `options` null; the
// DecisionPanel's resolve flow (open-option-N → decision-resolve →
// open-resolution-text → open-resolve-confirm) needs options to render the
// radio set, so we set the jsonb column directly after the service call. This
// is the lifecycle-spine journey's (t-7 / ac-13) "author + resolve a decision"
// precondition: candidate→approve is already covered by retained journey-14, so
// the spine seeds an OPEN decision and drives only the resolve half through the
// real UI.
const seedDecisionSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  title: z.string(),
  context: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), trade_offs: z.string().optional() }))
    .min(2),
});
testOnlyRouter.post("/seed-open-decision", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, title, context, options } = parsed.data;
  const decision = await createDecision(memexId, docId, title, context, "human");
  // createDecision intentionally leaves options null (the direct/human path);
  // the candidate path populates them. Set them here so the open-decision
  // resolve UI has a radio set to pick from.
  await db
    .update(decisions)
    .set({ options })
    .where(eq(decisions.id, decision.id));
  return c.json({ decisionId: decision.id, seq: decision.seq });
});

// Real native-auth signup [per std-13] that ALSO returns the raw email-
// verification token. The production signup handler (routes/auth/password.ts)
// emails the raw token and the auth_tokens table persists only its sha256 HASH
// (services/auth-tokens.ts) — so a test reading the table can never recover the
// raw token. This endpoint runs the same createUserWithPassword + issueAuthToken
// path the real handler does, but hands the raw token straight back to the test
// runner instead of to Postmark — Postmark is never contacted. It is the seam
// the lifecycle-spine journey's (t-7 / ac-13) signup leg needs.
//
// ⚠ BLOCKER (spec-172 t-7): this endpoint provisions the signed-up user and the
// raw token, but the journey still cannot AUTHENTICATE as that user. In the e2e
// stack GOOGLE_CLIENT_ID is unset → isDevMode() is true → session.ts's
// resolveBearerUser() short-circuits to dev@memex.ai BEFORE reading the
// Authorization header, shadowing any native-auth JWT the new user holds. The
// signup→verify→onboard arc is unrunnable as the new user without a server
// change (e.g. honour a presented session JWT even in dev mode). See t-7's
// returned blocker.
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
testOnlyRouter.post("/signup-with-token", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { email, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  const user = await createUserWithPassword({ email, passwordHash });
  await ensureUserMemex(user.id);
  const issued = await issueAuthToken({
    purpose: "email_verification",
    email: user.email,
    userId: user.id,
  });
  return c.json({ userId: user.id, verificationToken: issued.raw });
});

// ── tenancy seed surface (spec-172 t-6 / ac-5) ───────────────────────────────
// The tenancy journeys (org creation, invites, domains + auto-grouping,
// switching, member management, domain conflict) need to provision orgs,
// memberships, invite/verification tokens and verified domains WITHOUT touching
// Postmark or raw SQL. Each handler calls a real service (or the test-only
// seed-org helper, which itself calls createOrgForUser/createOrgWithOwner), so
// seeded rows are schema-current and (where the service emits) land on the bus
// [per std-8]. The verification-token read endpoint is the deliberate stand-in
// for the email a real user would receive — Postmark is never contacted.

// Mark a user's email verified — the precondition for creating an org
// (createOrgForUser rejects unverified users; the CreateOrgDialog gates the form
// on session.user.emailVerified). The dev-user bypass mints the dev user without
// emailVerifiedAt, so the org-creation journey calls this first.
testOnlyRouter.post("/mark-email-verified", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ email: z.string().email() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const user = await getUserByEmail(parsed.data.email);
  if (!user) return c.json({ error: `User ${parsed.data.email} not found` }, 404);
  await markEmailVerified(user.id);
  return c.json({ ok: true });
});

// Seed an Org + a default Memex with the named user as administrator. Backs the
// invites / settings / member-management / switching / conflict journeys, which
// need an org where the actor is already an admin (the org-creation journey
// itself drives the real CreateOrgForm instead). Returns the slugs the
// path-based URL helpers build `/<ns>/<mx>/...` from, plus the org/memex ids.
const seedOrgSchema = z.object({
  ownerEmail: z.string().email(),
  slug: z.string(),
  name: z.string().optional(),
  memexSlug: z.string().optional(),
  memexName: z.string().optional(),
});
testOnlyRouter.post("/seed-org", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedOrgSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const owner = await getUserByEmail(parsed.data.ownerEmail);
  if (!owner) return c.json({ error: `User ${parsed.data.ownerEmail} not found` }, 404);
  const seeded = await createOrgWithMemexForUser({
    slug: parsed.data.slug,
    name: parsed.data.name,
    userId: owner.id,
    memexSlug: parsed.data.memexSlug,
    memexName: parsed.data.memexName,
  });
  return c.json({
    orgId: seeded.org.id,
    namespaceSlug: seeded.namespace.slug,
    memexSlug: seeded.memex.slug,
    memexId: seeded.memex.id,
  });
});

// Add a member to an org (role/status default to active member). Backs the
// member-management + last-admin journeys (seed a peer user to promote/demote/
// remove) and the multi-org switching journey (put the actor in a second org).
const orgAddMemberSchema = z.object({
  orgId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["member", "administrator"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});
testOnlyRouter.post("/org-add-member", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = orgAddMemberSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const user = await getUserByEmail(parsed.data.email);
  if (!user) return c.json({ error: `User ${parsed.data.email} not found` }, 404);
  await db
    .insert(orgMemberships)
    .values({
      userId: user.id,
      orgId: parsed.data.orgId,
      role: parsed.data.role ?? "member",
      status: parsed.data.status ?? "active",
    })
    .onConflictDoNothing();
  return c.json({ ok: true, userId: user.id });
});

// Add a claimed email domain to an org (without verifying it). Backs the
// domain-conflict journey's losing side, where the second org must already claim
// the domain before its verify attempt 409s. Goes through updateOrgSettings so
// the change emits on the bus [per std-8].
const orgAddDomainSchema = z.object({
  orgId: z.string().uuid(),
  domain: z.string(),
});
testOnlyRouter.post("/org-add-domain", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = orgAddDomainSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, parsed.data.orgId),
  });
  if (!org) return c.json({ error: `Org ${parsed.data.orgId} not found` }, 404);
  const existing = (org.emailDomains as unknown[]).map((d) => String(d));
  await updateOrgSettings(parsed.data.orgId, {
    emailDomains: [...existing, parsed.data.domain.trim().toLowerCase()],
  });
  return c.json({ ok: true });
});

// Mint an invite token for an org and return the raw token — the stand-in for
// the invite URL an admin would copy. Backs the invite-accept journey's accept
// step (navigate /invite/:token). createInviteToken is silent-allowed per
// std-8 §6; consumption fires org_membership.created.
testOnlyRouter.post("/create-invite", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ orgId: z.string().uuid() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const invite = await createInviteToken(parsed.data.orgId);
  return c.json({ token: invite.token, inviteId: invite.id });
});

// Mint a domain-verification token for an org's claimed domain and return the
// raw token — the deliberate stand-in for the email a postmaster@ recipient
// would receive (Postmark is never hit). Backs the domain-verification journey's
// VerifyDomain click-to-POST step (navigate /verify-domain/:token).
const createDomainVerificationSchema = z.object({
  orgId: z.string().uuid(),
  domain: z.string(),
});
testOnlyRouter.post("/create-domain-verification", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createDomainVerificationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const created = await createDomainVerificationToken(
    parsed.data.orgId,
    parsed.data.domain,
  );
  return c.json({ token: created.token });
});

// Directly verify a domain for an org (server-side, no email round-trip). Backs
// the domain-conflict journey's WINNING side — pre-verify the domain for org A
// so org B's later verify attempt surfaces the 409. upsertVerifiedDomain throws
// ConflictError on a cross-org claim, mirroring the production guard.
const verifyDomainSchema = z.object({
  orgId: z.string().uuid(),
  domain: z.string(),
});
testOnlyRouter.post("/verify-domain", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifyDomainSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  await upsertVerifiedDomain(parsed.data.domain, parsed.data.orgId, "email");
  return c.json({ ok: true });
});

// ── spec-172 t-5 additive surface: retained-journey seeds/reads ──────────────
// These back the retained journeys re-based off raw SQL (dec-2): every mutation
// goes through a real service so it emits on the bus [per std-8], and reads
// replace the deleted raw-SQL DB-assertion crutches. Additive only — appended,
// never reordered (other agents touch this file).

// Seed a non-spec doc (standard / document) into a memex through createDocDraft,
// with the first section's content set to `body` so an FTS scan (e.g.
// scanForDecisionDrift's `[per dec-N]` match in journey-12) sees it. Returns the
// docId (cleanup) + handle (the canonical `/<ns>/<mx>/...` path).
const seedDocSchema = z.object({
  memexId: z.string().uuid(),
  title: z.string(),
  body: z.string().optional(),
  docType: z.enum(["standard", "document"]).default("standard"),
});
testOnlyRouter.post("/seed-doc", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedDocSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, title, body: content = "Seeded body.", docType } = parsed.data;
  const result = await createDocDraft(memexId, title, content, docType);
  // A standard is born sectionless (createDocDraft, spec-161), so add a rule
  // section explicitly through addSection — journey-12's FTS `[per dec-N]` scan
  // and journey-16's drift-flagging both need a section carrying `content`.
  // A document keeps createDocDraft's overview section.
  let sectionId = result.sections[0]?.id ?? null;
  if (docType === "standard") {
    const section = await addSection(memexId, result.id, "rule", content, "Rule");
    sectionId = section.id;
  }
  return c.json({ docId: result.id, handle: result.handle, sectionId });
});

// Read a doc's status (e.g. an execution plan flipping to 'approved' in
// journey-11). Replaces the journey's old raw-SQL poll on `documents.status`.
testOnlyRouter.get("/doc-status/:id", async (c) => {
  const docId = c.req.param("id");
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, docId),
  });
  if (!doc) return c.json({ error: `Document ${docId} not found` }, 404);
  return c.json({ status: doc.status });
});

// spec-196 t-5: set a doc's status through the real updateDocStatus service
// (bus-emitted, SSE-visible). Journeys use this to seed a Spec in a phase the
// UI can't browse to (e.g. `done` for the DoneSummary read view) without
// driving every intermediate gate.
const setDocStatusSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  status: z.string(),
});
testOnlyRouter.post("/set-doc-status", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = setDocStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, status } = parsed.data;
  const result = await updateDocStatus(memexId, docId, status);
  return c.json({ docId: result.id, status: result.status });
});

// spec-196 t-5: stamp `narrativeLastConsolidatedAt = now()` through the real
// markNarrativeConsolidated service — what `assess_spec({mode:'consolidate'})`
// does, reachable for journeys (the MCP surface isn't drivable from Playwright).
const consolidateSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
});
testOnlyRouter.post("/consolidate-narrative", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = consolidateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId } = parsed.data;
  const result = await markNarrativeConsolidated(memexId, docId);
  return c.json({ consolidatedAt: result.consolidatedAt });
});

// Resolve the latest active share token for a doc — the schema-current
// equivalent of journey-5's getLatestShareToken raw-SQL read, scoped through the
// real service (which asserts doc ownership).
testOnlyRouter.get("/latest-share-token", async (c) => {
  const docId = c.req.query("docId");
  const memexId = c.req.query("memexId");
  if (!docId || !memexId) {
    return c.json({ error: "docId and memexId query params required" }, 400);
  }
  const tokens = await listShareTokensForDoc(memexId, docId);
  return c.json({ token: tokens[0]?.token ?? null });
});

// Mint a share token for a doc through the real service — used when a journey
// needs an existing token without driving the UI's New-share-link flow.
const seedShareSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  createdByUserId: z.string().uuid().nullable().optional(),
});
testOnlyRouter.post("/seed-share-token", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedShareSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const token = await createShareToken(parsed.data.memexId, parsed.data.docId, parsed.data.createdByUserId ?? null);
  return c.json({ shareId: token.id, token: token.token });
});

// Seed the post-`submit_execution_plan` DB state journey-11 asserts on: a task,
// a linked execution plan, and a READY readiness-check comment — all through the
// real services (submit_execution_plan is MCP-only, so the journey can't drive
// the submit half through the in-app chat agent). Returns the taskId + planDocId
// so the journey can read the plan status back after Approve.
const seedPlanSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  taskTitle: z.string().optional(),
});
testOnlyRouter.post("/seed-execution-plan", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedPlanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, taskTitle = "Implement auth" } = parsed.data;
  const task = await createTask(memexId, docId, taskTitle, "Seeded task for the plan journey.");
  const plan = await createExecutionPlan(memexId, task.id, {
    sections: {
      files_modified: "src/auth.ts",
      dependency_flow: "auth → session",
      conflicts: "none",
      narrative: "Wire up scrypt-based auth.",
    },
  });
  // A readiness-check comment whose content starts with READY makes
  // derivePlanBadgeState render the trigger as "Plan: READY".
  await addTaskComment(memexId, task.id, "Memex agent", "READY — all green", {
    type: "readiness_check",
    source: "agent",
  });
  return c.json({ taskId: task.id, planDocId: plan.id });
});

// Append a section to a doc through the real addSection service (so it emits on
// the bus [per std-8]). Backs the layout journey's (journey-15) DocOutline check,
// which needs several named sections to assert the outline renders + scroll-to.
const seedSectionSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  title: z.string(),
  content: z.string().optional(),
  sectionType: z.string().optional(),
});
testOnlyRouter.post("/seed-section", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedSectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, title, content = "", sectionType = "context" } = parsed.data;
  const section = await addSection(memexId, docId, sectionType, content, title);
  return c.json({ sectionId: section.id, seq: section.seq });
});

// Resolve a user's role on a doc (editor / reviewer) through resolveRole — the
// schema-current equivalent of journey-17's dbDocRole raw-SQL read. A seeded doc
// has no doc_members editor row, so dev resolves to 'reviewer' until the UI's
// "Switch to editing" promotes it.
testOnlyRouter.get("/doc-role", async (c) => {
  const docId = c.req.query("docId");
  const memexId = c.req.query("memexId");
  const userId = c.req.query("userId");
  if (!docId || !memexId || !userId) {
    return c.json({ error: "docId, memexId and userId query params required" }, 400);
  }
  const role = await resolveRole(memexId, docId, userId);
  return c.json({ role });
});

// Count assignees on a doc through listAssignees — the schema-current equivalent
// of journey-17's dbAssigneeCount raw-SQL read.
testOnlyRouter.get("/assignee-count", async (c) => {
  const docId = c.req.query("docId");
  const memexId = c.req.query("memexId");
  if (!docId || !memexId) {
    return c.json({ error: "docId and memexId query params required" }, 400);
  }
  const assignees = await listAssignees(memexId, docId);
  return c.json({ count: assignees.length });
});

// ── spec-188 t-5: verify-phase journey seeds ────────────────────────────────

// Seed an AC on a Spec through the real service (emits on the bus per std-8).
// Returns the canonical ref alongside the ids so the journey can seed test
// events against it without rebuilding the ref grammar client-side.
const seedAcSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  kind: z.enum(["scope", "implementation"]).default("scope"),
  statement: z.string().min(1),
});
testOnlyRouter.post("/seed-ac", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedAcSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, kind, statement } = parsed.data;
  const ac = await createAc({ memexId, briefId: docId, kind, statement });
  const [slugRow] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      briefHandle: documents.handle,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, docId))
    .limit(1);
  const acUid =
    slugRow?.briefHandle != null ? buildAcRef(slugRow, ac.seq) : null;
  return c.json({ acId: ac.id, seq: ac.seq, acUid });
});

// Seed an Issue on a Spec through the real service (emits on the bus).
const seedIssueSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  type: z.enum(["bug", "todo"]).default("bug"),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(["open", "resolved", "wont_fix"]).default("open"),
});
testOnlyRouter.post("/seed-issue", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedIssueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, type, title, body: issueBody, status } = parsed.data;
  const issue = await createIssue({
    memexId,
    docId,
    type,
    title,
    body: issueBody,
    source: "human",
  });
  if (status !== "open") {
    const { updateIssueStatus } = await import("../services/issues.js");
    await updateIssueStatus(memexId, issue.id, status);
  }
  return c.json({ issueId: issue.id, seq: issue.seq });
});

// Seed a test-event emission for an acUid — the journey-side equivalent of
// the unit suites' seedTestEvent helper (insert + latest-summary upsert in one
// transaction), bypassing the emission-key gate the real POST /api/test-events
// enforces. Drives the spec-188 acceptance-precedence path (a failing event
// suppresses a manual acceptance).
const seedTestEventSchema = z.object({
  acUid: z.string().min(1),
  status: z.enum(["pass", "fail", "error"]),
  testIdentifier: z.string().default("e2e/seeded.spec.ts::seeded emission"),
});
testOnlyRouter.post("/seed-test-event", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedTestEventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { acUid, status, testIdentifier } = parsed.data;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(testEvents)
      .values({ acUid, status, testIdentifier, hidden: false })
      .returning({ createdAt: testEvents.createdAt });
    await applyEmissionToSummary(tx, {
      acUid,
      testIdentifier,
      status,
      latestRunAt: row.createdAt,
      hidden: false,
    });
  });
  return c.json({ ok: true });
});

// spec-234 t-3: seed an emission key (permanent or ephemeral) through the real mint
// services, so the Settings → Emission Keys journey can assert the two-key
// differentiation. Ephemeral keys are normally minted over MCP (provision_ac_emission);
// there is no UI path to create one, hence this seed.
const seedEmissionKeySchema = z.object({
  memexId: z.string().uuid(),
  createdByUserId: z.string().uuid(),
  kind: z.enum(["permanent", "ephemeral"]),
  name: z.string().min(1).optional(),
  specHandle: z.string().min(1).optional(),
});
testOnlyRouter.post("/seed-emission-key", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedEmissionKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, createdByUserId, kind, name, specHandle } = parsed.data;
  const minted =
    kind === "ephemeral"
      ? await mintEphemeralEmissionKey(memexId, specHandle ?? "spec-1", createdByUserId)
      : await mintEmissionKey(memexId, name ?? "ci", createdByUserId);
  return c.json({ id: minted.row.id, prefix: minted.row.prefix });
});

// Seed a Task on a Spec through the real service (spec-188 t-7: drives the
// Build-tab completion Metric and the Verify-tab task echo in journeys).
const seedTaskSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().default("Seeded task."),
  status: z.enum(["not_started", "in_progress", "complete"]).default("not_started"),
});
testOnlyRouter.post("/seed-task", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, title, description, status } = parsed.data;
  const task = await createTask(memexId, docId, title, description);
  if (status !== "not_started") {
    const { updateTaskStatus } = await import("../services/tasks.js");
    await updateTaskStatus(memexId, task.id, status);
  }
  return c.json({ taskId: task.id, seq: task.seq });
});

// spec-199 t-9: security journey seeds ──────────────────────────────────────

// Seed an assignee on a Spec through the real assign service (so the bus emits
// and schema drift breaks the server build, per spec-172 dec-2).
const seedAssigneeSchema = z.object({
  memexId: z.string().uuid(),
  docId: z.string().uuid(),
  userId: z.string().uuid(),
});
testOnlyRouter.post("/seed-assignee", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedAssigneeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, docId, userId } = parsed.data;
  const result = await assign(memexId, docId, userId, null);
  return c.json({ assigneeId: result.id });
});

// Flip a Memex's visibility (public | private) through the real service.
// Journeys that test the public-memex non-member path call this to make the
// seeded memex reachable before asserting column redaction.
const setMemexVisibilitySchema = z.object({
  memexId: z.string().uuid(),
  visibility: z.enum(["public", "private"]),
});
testOnlyRouter.post("/set-memex-visibility", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = setMemexVisibilitySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  await updateMemexVisibility(parsed.data.memexId, parsed.data.visibility);
  return c.json({ ok: true });
});

// Seed an activity_log row through the real persistEvent service. Used by the
// spec-199 non-member redaction journey to plant a row with actorUserId +
// clientId + payload set before asserting the public endpoint strips those columns.
const seedActivitySchema = z.object({
  memexId: z.string().uuid(),
  actorUserId: z.string().uuid().nullable().optional(),
  clientId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  narrative: z.string().optional(),
});
testOnlyRouter.post("/seed-activity", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedActivitySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { memexId, actorUserId, clientId, payload, narrative } = parsed.data;
  const row = await persistEvent({
    memexId,
    userId: actorUserId ?? undefined,
    clientId: clientId ?? undefined,
    channel: "rest_ui",
    entity: "document",
    action: "updated",
    narrative: narrative ?? "seeded",
    payload: payload ?? undefined,
  });
  if (!row) return c.json({ error: "Failed to insert activity row" }, 500);
  return c.json({ activityId: row.id });
});

// Directly disable an org member and bulk-revoke their share tokens through the
// real disableMembership service — bypasses sessionMiddleware/adminGate so the
// test doesn't need to navigate auth. Caller must ensure a second admin exists
// in the org (so the last-admin guard passes); tests that add dev as admin before
// calling this satisfy that requirement automatically.
const disableMemberSchema = z.object({
  orgId: z.string().uuid(),
  targetUserId: z.string().uuid(),
});
testOnlyRouter.post("/disable-member", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = disableMemberSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const { orgId, targetUserId } = parsed.data;
  // Find any other active admin to act as requester (satisfies the self-remove
  // guard without needing a real session).
  const admins = await db
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, "active"),
        eq(orgMemberships.role, "administrator"),
      ),
    )
    .limit(5);
  const requester = admins.find((r) => r.userId !== targetUserId);
  if (!requester) {
    return c.json({ error: "No other admin found to act as requester" }, 400);
  }
  await disableMembership(targetUserId, orgId, requester.userId);
  return c.json({ ok: true });
});
