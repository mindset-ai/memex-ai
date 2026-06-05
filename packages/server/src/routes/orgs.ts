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
import { memexes, namespaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
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
