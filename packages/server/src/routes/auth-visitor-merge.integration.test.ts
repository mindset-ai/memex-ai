// Integration tests for the visitor→user identify merge wired into the auth flows
// (spec-254 t-4) — REAL Postgres, REAL auth routes driven over HTTP.
//
// Mirrors the real app wiring: visitorMiddleware on /api/* (reads the cookie) ahead
// of the auth router. A request that carries a consented visitor cookie, on
// completing any auth flow, links that visitor_id to the now-known user. The
// bind-once invariant (dec-3) holds across account churn on one browser: a second
// user authenticating with the same cookie does NOT re-point the binding, and the
// cookie is cleared so they mint fresh.

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// Set before importing modules that capture env at load (mirrors auth-signup test).
const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = ""; // dev-mode SSO → dev user
  return v;
});
const ORIGINAL_JWT_SECRET = vi.hoisted(() => {
  const v = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = "x".repeat(48);
  return v;
});

import { Hono } from "hono";
import { db } from "../db/connection.js";
import { users, visitors, usageEvents } from "../db/schema.js";
import { getUserByEmail } from "../services/users.js";
import { resetRateLimits } from "../services/auth-rate-limit.js";
import { setEmailSender, type EmailSender, type EmailMessage } from "../services/email/sender.js";
import { errorHandler } from "../middleware/error-handler.js";
import { visitorMiddleware, VISITOR_COOKIE } from "../middleware/visitor.js";
import { auth } from "./auth.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-254/acs";
const AC324 = "mindset-prod/memex-building-itself/specs/spec-324/acs";

class CapturingSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
let sender: CapturingSender;

// Test app mirrors the real wiring: visitor reader on /api/* ahead of auth.
const app = new Hono();
app.onError(errorHandler);
app.use("/api/*", visitorMiddleware);
app.route("/api/auth", auth);

const createdEmails: string[] = [];
const mintedVisitors: string[] = [];

function uniqueEmail(prefix: string): string {
  const e = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  createdEmails.push(e);
  return e;
}
function vid(): string {
  const id = randomUUID();
  mintedVisitors.push(id);
  return id;
}
function extractLinkToken(text: string): string | null {
  const m = text.match(/token=([^\s&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function cookie(id: string): Record<string, string> {
  return { "Content-Type": "application/json", cookie: `${VISITOR_COOKIE}=${id}` };
}
async function userIdFor(email: string): Promise<string> {
  const u = await getUserByEmail(email);
  return u!.id;
}
async function visitorRow(id: string) {
  const [row] = await db.select().from(visitors).where(eq(visitors.visitorId, id));
  return row;
}

beforeEach(() => {
  sender = new CapturingSender();
  setEmailSender(sender);
  resetRateLimits();
});

afterAll(async () => {
  if (mintedVisitors.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.visitorId, mintedVisitors)).catch(() => {});
    await db.delete(visitors).where(inArray(visitors.visitorId, mintedVisitors)).catch(() => {});
  }
  if (createdEmails.length) {
    const ids = (
      await db.select({ id: users.id }).from(users).where(inArray(users.email, createdEmails))
    ).map((r) => r.id);
    if (ids.length) await db.delete(users).where(inArray(users.id, ids)).catch(() => {});
  }
  setEmailSender(null);
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
});

describe("identify merge across the auth flows (ac-3, ac-10)", () => {
  it("password signup links the request's visitor_id to the new user", async () => {
    tagAc(`${AC}/ac-3`);
    tagAc(`${AC}/ac-10`);
    const id = vid();
    const email = uniqueEmail("signup");
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect(res.status).toBe(201);
    const row = await visitorRow(id);
    expect(row?.userId).toBe(await userIdFor(email));
    expect(row?.mergedAt).not.toBeNull();
  });

  it("password login links the visitor_id (idempotent on the same user)", async () => {
    tagAc(`${AC}/ac-3`);
    tagAc(`${AC}/ac-10`);
    const email = uniqueEmail("login");
    // Signup first (no cookie), then login carrying the cookie.
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    const id = vid();
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect(res.status).toBe(200);
    expect((await visitorRow(id))?.userId).toBe(await userIdFor(email));
  });

  it("magic-link consume links the visitor_id (email-only signup path)", async () => {
    tagAc(`${AC}/ac-3`);
    const email = uniqueEmail("magic");
    await app.request("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const token = extractLinkToken(sender.sent[0].text)!;
    const id = vid();
    const res = await app.request("/api/auth/magic-link/consume", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await visitorRow(id))?.userId).toBe(await userIdFor(email));
  });

  it("verify-email links the visitor_id", async () => {
    tagAc(`${AC}/ac-3`);
    const email = uniqueEmail("verify");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    const token = extractLinkToken(sender.sent[0].text)!;
    const id = vid();
    const res = await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await visitorRow(id))?.userId).toBe(await userIdFor(email));
  });

  it("Google SSO (dev-mode) links the visitor_id to the resolved user", async () => {
    tagAc(`${AC}/ac-3`);
    const id = vid();
    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ idToken: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((await visitorRow(id))?.userId).toBe(body.user.id);
  });
});

describe("identity.merged → the Mixpanel stitch (spec-324 ac-9)", () => {
  async function identityMergeRows(visitorId: string) {
    return db
      .select()
      .from(usageEvents)
      .where(
        and(eq(usageEvents.visitorId, visitorId), eq(usageEvents.name, "identity.merged")),
      );
  }

  it("signup with a visitor cookie emits identity.merged carrying BOTH the user id and the visitor_id", async () => {
    tagAc(`${AC324}/ac-9`);
    tagAc(`${AC324}/ac-3`); // scope: the pre-auth visitor event joins to the user at signup
    tagAc(`${AC324}/ac-4`); // scope: the head→tail funnel is joinable per user via the stitch
    const id = vid();
    const email = uniqueEmail("idmerge");
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect(res.status).toBe(201);

    const userId = await userIdFor(email);
    const rows = await identityMergeRows(id);
    expect(rows.length).toBe(1); // exactly one stitch, at the first bind
    expect(rows[0].actorUserId).toBe(userId); // $user_id
    expect(rows[0].visitorId).toBe(id); // $device_id — both ids on one event
    expect(rows[0].memexId).toBeNull();
  });

  it("does NOT emit identity.merged again on a same-user re-auth ('already')", async () => {
    tagAc(`${AC324}/ac-9`);
    const id = vid();
    const email = uniqueEmail("idmerge-reauth");
    // First auth binds + stitches once.
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    // Re-auth on the same cookie → mergeVisitor returns 'already' → no new stitch.
    await app.request("/api/auth/login", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect((await identityMergeRows(id)).length).toBe(1);
  });

  it("does NOT emit identity.merged for a DIFFERENT user on the same browser ('rebind')", async () => {
    tagAc(`${AC324}/ac-9`);
    const id = vid();
    const emailA = uniqueEmail("idmerge-a");
    const emailB = uniqueEmail("idmerge-b");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email: emailA, password: "correctbattery" }),
    });
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email: emailB, password: "correctbattery" }),
    });
    // Only A's stitch exists — B's merge was a 'rebind' (bind-once), so no event
    // wrongly attributes the visitor's pre-auth events to B.
    const rows = await identityMergeRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0].actorUserId).toBe(await userIdFor(emailA));
  });
});

describe("bind-once across account churn on one browser (ac-4, ac-11)", () => {
  it("a second user on the same cookie does NOT re-point the binding, and the cookie is cleared", async () => {
    tagAc(`${AC}/ac-4`);
    tagAc(`${AC}/ac-11`);
    const id = vid();
    const emailA = uniqueEmail("churn-a");
    const emailB = uniqueEmail("churn-b");

    // User A signs up on this browser → visitor binds to A.
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email: emailA, password: "correctbattery" }),
    });
    const userA = await userIdFor(emailA);
    expect((await visitorRow(id))?.userId).toBe(userA);

    // User B signs up on the SAME browser (same cookie).
    const resB = await app.request("/api/auth/signup", {
      method: "POST",
      headers: cookie(id),
      body: JSON.stringify({ email: emailB, password: "correctbattery" }),
    });
    expect(resB.status).toBe(201);

    // Binding is unchanged (still A) — bind-once held.
    expect((await visitorRow(id))?.userId).toBe(userA);
    // And the cookie was cleared so B mints fresh on next load.
    const setCookie = resB.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(VISITOR_COOKIE);
  });
});
