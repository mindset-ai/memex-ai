import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { adminGate } from "../middleware/permissions.js";
import {
  createOrgForUser,
  getOrgSummary,
  updateOrgSettings,
  refreshOrgDomainVerifiedFlag,
} from "../services/orgs.js";
import { getMemexById } from "../services/memexes.js";
import {
  createDomainVerificationToken,
  consumeDomainVerificationToken,
  DomainVerificationError,
} from "../services/domain-verification.js";
import { listOrgMembers } from "../services/users.js";
import {
  disableMembership,
  enableMembership,
  updateMembershipRole,
  MembershipActionError,
} from "../services/org-memberships.js";
import { getEmailSender } from "../services/email/sender.js";
import { buildDomainVerificationEmail } from "../services/email/templates.js";
import { buildAppBaseUrl } from "../services/shared/tenant-url.js";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships } from "../db/schema.js";
import { eq, and, count } from "drizzle-orm";
import {
  createBillingPortalSession,
  createStripeCustomer,
  createCheckoutSession,
  updateSubscriptionSeats,
  previewUpcomingInvoice,
  getSubscription,
  resolvePlanFromPriceId,
  type BillingCycle,
} from "../services/stripe.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { readJsonBody, requireString } from "./validation.js";

// /api/orgs — t-14 + t-16 of doc-15. Replaces /api/accounts + /api/account.
//
// SPLIT INTO TWO ROUTERS (drift fix of the t-12 path-routing migration):
//
// orgsRouter — mounted flat at /api/orgs. Caller-scoped + public surfaces only:
//   POST   /api/orgs                                    — create an org
//   GET    /api/orgs/check?slug=...                     — slug availability
//   PATCH  /api/orgs/:id/slug                           — rename slug (cooldown)
//   POST   /api/orgs/domains/verify/:token              — PUBLIC: consume domain token
//                                                         (bypasses admin gate so admin@
//                                                         /postmaster@ inboxes can click)
//
// orgsCurrentRouter — mounted prefixed at /api/<ns>/<mx>/orgs/current/*. Admin
// operations on the caller's current org. These NEED a resolved memex (which
// memexResolver supplies only for path-prefixed URLs); mounting them flat
// universally 400-ed with "Memex context required".
//   GET    /api/<ns>/<mx>/orgs/current                  — current org summary
//   PATCH  /api/<ns>/<mx>/orgs/current                  — update org settings
//   GET    /api/<ns>/<mx>/orgs/current/members          — admin: full member list
//   PATCH  /api/<ns>/<mx>/orgs/current/members/:userId  — admin: change role / disable
//   POST   /api/<ns>/<mx>/orgs/current/domains/verify   — admin: initiate domain verification

export const orgsRouter = new Hono<SessionEnv>();

// Public endpoint for completing email-based verification — must come BEFORE any
// session middleware so unauthenticated recipients (admin@/postmaster@ inboxes) can
// click through. The token itself is the proof of authorization (only the email
// recipient could have it).
orgsRouter.post("/domains/verify/:token", async (c) => {
  const token = c.req.param("token");
  try {
    const verified = await consumeDomainVerificationToken(token);
    await refreshOrgDomainVerifiedFlag(verified.orgId);
    return c.json({
      domain: verified.domain,
      method: verified.verificationMethod,
      verifiedAt: verified.verifiedAt,
    });
  } catch (err) {
    if (err instanceof DomainVerificationError) {
      return c.json({ error: "Invalid verification link", reason: err.reason, message: err.message }, 400);
    }
    if (err instanceof ConflictError) {
      return c.json({ error: "Conflict", message: err.message }, 409);
    }
    throw err;
  }
});

orgsRouter.use("*", sessionMiddleware);

// POST /api/orgs — create an org.
// Body: { slug: string, name?: string }
orgsRouter.post("/", async (c) => {
  const user = c.get("user");
  if (!user.emailVerifiedAt) {
    return c.json(
      { error: "Email not verified", code: "email_not_verified" },
      403,
    );
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.slug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }

  try {
    const result = await createOrgForUser({
      slug: body.slug,
      name: typeof body.name === "string" ? body.name : undefined,
      userId: user.id,
    });
    return c.json(
      {
        org: result.org,
        namespace: result.namespace,
      },
      201,
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      // Distinguish the rate-limit case so the React UI can show a specific
      // message ("you've created 5 orgs in the past 24 hours").
      const isRateLimit = err.message.toLowerCase().includes("rate limit");
      return c.json(
        {
          error: err.message,
          code: isRateLimit ? "rate_limit_exceeded" : "validation_error",
        },
        isRateLimit ? 429 : 400,
      );
    }
    if (err instanceof ConflictError) {
      return c.json({ error: err.message, code: "slug_taken" }, 409);
    }
    throw err;
  }
});

// Walks the resolved memex back to its owning org. Returns null for personal
// memexes (the route handlers below 404 in that case).
async function resolveOrgIdFromMemex(memexId: string): Promise<string | null> {
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!mx) return null;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, mx.namespaceId) });
  if (!ns) return null;
  return ns.ownerOrgId ?? null;
}

// ── /api/<ns>/<mx>/orgs/current/* — admin-only operations on the caller's current org ─
//
// This router is mounted by app.ts UNDER the tenant prefix, i.e.
// `/api/:namespace/:memex/orgs`. memexResolver populates ctx.memex from the
// URL prefix; sessionMiddleware then sets currentMemexId from that, so the
// adminGate's "memexId present" check passes for any caller hitting a real
// tenant URL. Previously these routes were flat-mounted at `/api/orgs/current/*`
// and universally 400'd with "Memex context required" because no resolver set
// the ctx variable.

export const orgsCurrentRouter = new Hono<SessionEnv>();
orgsCurrentRouter.use("/*", sessionMiddleware);

// GET /api/<ns>/<mx>/orgs/current — current org's settings + computed flags for the UI
orgsCurrentRouter.get("/current", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);
  const summary = await getOrgSummary(orgId);
  if (!summary) return c.json({ error: "Org not found" }, 404);
  return c.json(summary);
});

// PATCH /api/<ns>/<mx>/orgs/current — update settings (name, email_domains, auto_grouping_enabled).
orgsCurrentRouter.patch("/current", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);
  const body = await c.req.json().catch(() => {
    throw new ValidationError("Request body must be valid JSON");
  });

  const input: Parameters<typeof updateOrgSettings>[1] = {};
  if (typeof body?.name === "string") input.name = body.name;
  if (Array.isArray(body?.emailDomains)) {
    if (!body.emailDomains.every((d: unknown) => typeof d === "string")) {
      return c.json({ error: "emailDomains must be an array of strings" }, 400);
    }
    input.emailDomains = body.emailDomains;
  }
  if (typeof body?.autoGroupingEnabled === "boolean") {
    input.autoGroupingEnabled = body.autoGroupingEnabled;
  }
  if (typeof body?.billingContactName === "string" || body?.billingContactName === null) {
    input.billingContactName = body.billingContactName as string | null;
  }
  if (typeof body?.billingContactEmail === "string" || body?.billingContactEmail === null) {
    input.billingContactEmail = body.billingContactEmail as string | null;
  }

  try {
    const summary = await updateOrgSettings(orgId, input);
    return c.json(summary);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid update", message: err.message }, 400);
    }
    throw err;
  }
});

// GET /api/<ns>/<mx>/orgs/current/members — full member list (active + disabled) for the React UI admin tab.
orgsCurrentRouter.get("/current/members", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);
  const members = await listOrgMembers(orgId);
  return c.json(members);
});

// PATCH /api/<ns>/<mx>/orgs/current/members/:userId — admin operations on a single member.
orgsCurrentRouter.patch("/current/members/:userId", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);
  const requester = c.get("user")!;
  const targetUserId = c.req.param("userId");
  const body = await c.req.json().catch(() => ({}));

  const role: unknown = body?.role;
  const status: unknown = body?.status;
  if (role === undefined && status === undefined) {
    return c.json({ error: "Provide at least one of: role, status" }, 400);
  }

  try {
    if (role !== undefined) {
      if (role !== "member" && role !== "administrator") {
        return c.json({ error: "Invalid role", code: "invalid_role" }, 400);
      }
      await updateMembershipRole(targetUserId, orgId, role, requester.id);
    }
    if (status !== undefined) {
      if (status === "disabled") {
        await disableMembership(targetUserId, orgId, requester.id);
      } else if (status === "active") {
        await enableMembership(targetUserId, orgId);
      } else {
        return c.json({ error: "Invalid status", code: "invalid_status" }, 400);
      }
    }
    const members = await listOrgMembers(orgId);
    const updated = members.find((m) => m.userId === targetUserId);
    if (!updated) return c.json({ error: "Member not found" }, 404);
    return c.json(updated);
  } catch (err) {
    if (err instanceof MembershipActionError) {
      const status = err.code === "not_found" ? 404 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    throw err;
  }
});

// POST /api/<ns>/<mx>/orgs/current/subscription — admin: start a hosted purchase.
// Body: { plan: 'premium'|'enterprise', seats: number, billingCycle: 'monthly'|'annual' }
// spec-171 dec-38 / ac-33: payment is collected on a Stripe-hosted Checkout page,
// so NO raw card / PaymentMethod data is accepted here. We ensure the org has a
// Stripe customer (create + persist on first purchase), create a Checkout Session
// tagged with org_id metadata, and return its redirect URL. The subscription row
// (plan_tier / stripe_subscription_id / seats_purchased) is written by the
// `checkout.session.completed` webhook — NOT here.
orgsCurrentRouter.post("/current/subscription", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { plan, seats, billingCycle } = body;

  if (plan !== "premium" && plan !== "enterprise") {
    return c.json({ error: "plan must be 'premium' or 'enterprise'" }, 400);
  }
  if (typeof seats !== "number" || seats < 1 || !Number.isInteger(seats)) {
    return c.json({ error: "seats must be a positive integer" }, 400);
  }
  if (billingCycle !== "monthly" && billingCycle !== "annual") {
    return c.json({ error: "billingCycle must be 'monthly' or 'annual'" }, 400);
  }

  const [org] = await db
    .select({
      stripeCustomerId: orgs.stripeCustomerId,
      stripeSubscriptionId: orgs.stripeSubscriptionId,
      name: orgs.name,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: "Org not found" }, 404);

  // spec-171 t-24 / issue-7: re-purchase double-bill guard. A new-purchase
  // checkout is only for orgs WITHOUT an active subscription — opening a second
  // Checkout Session for an org that already has one creates a SECOND Stripe
  // subscription (double billing). Seat changes go through the separate PATCH
  // path. The cancel webhook clears stripe_subscription_id, so a cancelled org
  // can re-purchase. Guard BEFORE any Stripe call so a subscribed org never
  // touches Stripe.
  if (org.stripeSubscriptionId) {
    return c.json(
      { error: "This org already has an active subscription; manage it from Settings > Billing" },
      409,
    );
  }

  const user = c.get("user")!;

  let customerId = org.stripeCustomerId;
  if (!customerId) {
    customerId = await createStripeCustomer(user.email, org.name, orgId);
    await db.update(orgs).set({ stripeCustomerId: customerId }).where(eq(orgs.id, orgId));
  }

  const baseUrl = buildAppBaseUrl();
  // issue-16: carry the purchased org's tenant (namespace/memexSlug) through the
  // success_url. After the full browser redirect back from stripe.com, React
  // Router state is gone and the confirmation page can't tell WHICH org was
  // purchased (the session's current memex is the non-billable personal one).
  // These params come straight off the request path the client targeted
  // (/api/<ns>/<mx>/orgs/current/subscription), so they are the purchased org.
  const namespaceSlug = c.req.param("namespace");
  const memexSlug = c.req.param("memex");
  const orgParam =
    namespaceSlug && memexSlug
      ? `&org=${encodeURIComponent(`${namespaceSlug}/${memexSlug}`)}`
      : "";
  const session = await createCheckoutSession({
    customerId,
    orgId,
    plan,
    seats,
    billingCycle,
    // Confirmation page falls back to fetching the live subscription using the
    // session id when React Router state is absent (full browser redirect back
    // from stripe.com discards in-app state). The `org` param tells it WHICH
    // org's subscription to poll (issue-16).
    successUrl: `${baseUrl}/upgrade/confirmation?session_id={CHECKOUT_SESSION_ID}${orgParam}`,
    cancelUrl: `${baseUrl}/upgrade/${plan}`,
  });

  return c.json({ url: session.url });
});

// GET /api/<ns>/<mx>/orgs/current/subscription/preview — admin: preview proration for a seat-count change.
// Query: ?seats=N  (proposed new seat count)
// Returns { amountDue, currency } — positive = charge today, negative = credit on next invoice.
// 402 when the org has no active Stripe subscription.
orgsCurrentRouter.get("/current/subscription/preview", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const seatsRaw = c.req.query("seats");
  const seats = seatsRaw ? parseInt(seatsRaw, 10) : NaN;
  if (isNaN(seats) || seats < 1) return c.json({ error: "seats must be a positive integer" }, 400);

  const [org] = await db
    .select({ stripeCustomerId: orgs.stripeCustomerId, stripeSubscriptionId: orgs.stripeSubscriptionId })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: "Org not found" }, 404);
  if (!org.stripeCustomerId || !org.stripeSubscriptionId) {
    return c.json({ error: "No active subscription" }, 402);
  }

  const preview = await previewUpcomingInvoice(org.stripeCustomerId, org.stripeSubscriptionId, seats);
  return c.json(preview);
});

// PATCH /api/<ns>/<mx>/orgs/current/subscription — admin: update seat count on an active subscription.
// Body: { seats: number }
// Applies immediately with proration per dec-11. 402 when no active subscription.
orgsCurrentRouter.patch("/current/subscription", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const body = await readJsonBody<{ seats?: unknown }>(c);
  const seats = typeof body?.seats === "number" ? body.seats : parseInt(String(body?.seats), 10);
  if (isNaN(seats) || seats < 1) return c.json({ error: "seats must be a positive integer" }, 400);

  const [org] = await db
    .select({ stripeSubscriptionId: orgs.stripeSubscriptionId })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: "Org not found" }, 404);
  if (!org.stripeSubscriptionId) return c.json({ error: "No active subscription" }, 402);

  await updateSubscriptionSeats(org.stripeSubscriptionId, seats);
  await db.update(orgs).set({ seatsPurchased: seats }).where(eq(orgs.id, orgId));

  return c.json({ ok: true, seatsPurchased: seats });
});

// GET /api/<ns>/<mx>/orgs/current/billing-portal — admin: generate a Stripe Billing Portal session URL.
// Query: ?returnUrl=<encoded-url>  (where to send the user back from the portal)
// Returns { url } — the short-lived Stripe-hosted portal URL.
// 402 when the org has no Stripe customer yet (hasn't purchased).
orgsCurrentRouter.get("/current/billing-portal", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const returnUrl = c.req.query("returnUrl");
  if (!returnUrl || !returnUrl.trim()) {
    return c.json({ error: "returnUrl query parameter is required" }, 400);
  }

  const [org] = await db
    .select({ stripeCustomerId: orgs.stripeCustomerId })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: "Org not found" }, 404);
  if (!org.stripeCustomerId) {
    return c.json({ error: "No active subscription — complete a purchase first" }, 402);
  }

  const url = await createBillingPortalSession(org.stripeCustomerId, returnUrl.trim());
  return c.json({ url });
});

// GET /api/<ns>/<mx>/orgs/current/subscription — admin: current plan tier, seat counts, and billing info.
// Returns the org's Stripe tier (free/premium/enterprise/self-hosted-enterprise), active member count,
// and a seatsWarning when active members exceed purchased seats. Used by the frontend to drive
// feature flags and the Settings > Billing display (per s-8 tier query section of spec-171).
orgsCurrentRouter.get("/current/subscription", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const [org] = await db
    .select({
      stripeCustomerId: orgs.stripeCustomerId,
      stripeSubscriptionId: orgs.stripeSubscriptionId,
      planTier: orgs.planTier,
      seatsPurchased: orgs.seatsPurchased,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: "Org not found" }, 404);

  // Count non-disabled members
  const [{ value: activeMemberCount }] = await db
    .select({ value: count() })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, "active")));

  const tier = org.stripeCustomerId && org.planTier ? org.planTier : "free";
  const seatsPurchased = org.seatsPurchased ?? null;

  const seatsWarning =
    seatsPurchased !== null && activeMemberCount > seatsPurchased
      ? { purchased: seatsPurchased, active: activeMemberCount }
      : null;

  // issue-15: surface the billing interval + next billing date the webhook
  // doesn't persist. When the org has a live subscription, retrieve it from
  // Stripe and derive the cycle (from the price id — the same source of truth
  // the webhook uses for the tier, via resolvePlanFromPriceId) and the next
  // billing date (current_period_end, top-level on older API versions, on the
  // first item on newer ones). Resilient: a Stripe failure must NOT 500 the
  // billing page — we fall back to nulls and still return the persisted data.
  let billingCycle: BillingCycle | null = null;
  let currentPeriodEnd: string | null = null;
  if (org.stripeSubscriptionId) {
    try {
      const subscription = await getSubscription(org.stripeSubscriptionId);
      const priceId = subscription.items.data[0]?.price.id;
      billingCycle = priceId ? (resolvePlanFromPriceId(priceId)?.billingCycle ?? null) : null;
      const periodEndUnix =
        subscription.current_period_end ?? subscription.items.data[0]?.current_period_end;
      currentPeriodEnd =
        typeof periodEndUnix === "number"
          ? new Date(periodEndUnix * 1000).toISOString()
          : null;
    } catch (err) {
      console.error("Failed to enrich subscription from Stripe:", err);
    }
  }

  return c.json({
    tier,
    seatsPurchased,
    activeMemberCount,
    billingCycle,
    currentPeriodEnd,
    seatsWarning,
  });
});

// POST /api/<ns>/<mx>/orgs/current/domains/verify — admin initiates email-based verification for a domain.
// Sends to admin@<domain> and postmaster@<domain> per RFC 2142.
orgsCurrentRouter.post("/current/domains/verify", adminGate, async (c) => {
  const memexId = c.get("currentMemexId")!;
  const orgId = await resolveOrgIdFromMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);
  const body = await readJsonBody<{ domain?: unknown }>(c);
  const domain = requireString(body?.domain, "domain", { trim: true });

  // The verification email needs the org's name; the memex object doesn't carry it,
  // so resolve via the summary helper which walks namespace + verified_domains.
  const memex = await getMemexById(memexId);
  if (!memex) return c.json({ error: "Memex not found" }, 404);

  let tokenRow;
  try {
    tokenRow = await createDomainVerificationToken(orgId, domain);
  } catch (err) {
    if (err instanceof ConflictError) {
      return c.json({ error: "Conflict", message: err.message }, 409);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid", message: err.message }, 400);
    }
    throw err;
  }

  // `/verify-domain/:token` is a flat public route — no tenant prefix in the URL.
  // Per [std-2] flat routes live under the app base host (`int.memex.ai` or
  // `memex.ai`); the token alone identifies the org/domain.
  const summary = await getOrgSummary(orgId);
  const verifyUrl = `${buildAppBaseUrl()}/verify-domain/${tokenRow.token}`;

  const sender = getEmailSender();
  const recipients = [`admin@${tokenRow.domain}`, `postmaster@${tokenRow.domain}`];
  const sendErrors: string[] = [];
  for (const to of recipients) {
    const message = buildDomainVerificationEmail({
      to,
      orgName: summary?.name ?? memex.name,
      domain: tokenRow.domain,
      verifyUrl,
    });
    try {
      await sender.send(message);
    } catch (err) {
      sendErrors.push(`${to}: ${(err as Error).message}`);
    }
  }

  return c.json(
    {
      id: tokenRow.id,
      domain: tokenRow.domain,
      expiresAt: tokenRow.expiresAt,
      sentTo: recipients,
      sendErrors: sendErrors.length > 0 ? sendErrors : undefined,
    },
    201
  );
});
