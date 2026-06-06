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
import { users, namespaces, memexes, orgMemberships, orgs, documents, decisions } from "../db/schema.js";
import {
  getUserByEmail,
  upsertUserByEmail,
  updateUserProfile,
  markEmailVerified,
  createUserWithPassword,
} from "../services/users.js";
import { ensureUserNamespace, ensureUserMemex } from "../services/user-namespaces.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { hashPassword } from "../services/passwords.js";
import { issueAuthToken } from "../services/auth-tokens.js";
import { mutate } from "../services/mutate.js";
import { createOrgWithMemexForUser } from "../services/__test__/seed-org.js";
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
import { listAssignees } from "../services/doc-assignees.js";

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
  // The first (overview/purpose) section id — handy for journeys that mutate a
  // section over the API (e.g. the reactivity round-trips in journey-16).
  return c.json({ docId: result.id, handle: result.handle, sectionId: result.sections[0]?.id ?? null });
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
});
testOnlyRouter.post("/seed-share-token", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = seedShareSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const token = await createShareToken(parsed.data.memexId, parsed.data.docId);
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
