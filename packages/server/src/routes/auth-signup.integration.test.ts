// End-to-end integration tests for the email/password + magic-link + verification flows.
// Spawns a minimal Hono app with the auth router, mocks the email sender to capture
// outgoing messages, and drives the HTTP surface with app.request().

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

// Must run before imports so module-level googleClientId/AUTH_JWT_SECRET captures load cleanly.
const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "";
  return v;
});
const ORIGINAL_JWT_SECRET = vi.hoisted(() => {
  const v = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = "x".repeat(48);
  return v;
});

import { db } from "../db/connection.js";
import { users, authTokens } from "../db/schema.js";
import { getUserByEmail, markEmailVerified } from "../services/users.js";
import { resetRateLimits } from "../services/auth-rate-limit.js";
import {
  setEmailSender,
  type EmailSender,
  type EmailMessage,
} from "../services/email/sender.js";

import { Hono } from "hono";
import { auth } from "./auth.js";
import { errorHandler } from "../middleware/error-handler.js";

afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
  setEmailSender(null);
});

// Capturing sender — each test starts with a fresh inbox.
class CapturingSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

let sender: CapturingSender;
const app = new Hono();
app.onError(errorHandler);
app.route("/api/auth", auth);

const createdEmails: string[] = [];

beforeAll(async () => {
  // Clean slate for the dev user so rate limiters and previous tokens don't interfere.
});

beforeEach(() => {
  sender = new CapturingSender();
  setEmailSender(sender);
  resetRateLimits();
});

afterAll(async () => {
  if (createdEmails.length) {
    const ids = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, createdEmails))
    ).map((r) => r.id);
    if (ids.length) {
      await db.delete(authTokens).where(inArray(authTokens.userId, ids)).catch(() => {});
      await db.delete(users).where(inArray(users.id, ids)).catch(() => {});
    }
  }
});

function uniqueEmail(prefix: string): string {
  const e = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  createdEmails.push(e);
  return e;
}

function extractLinkToken(text: string): string | null {
  const m = text.match(/token=([^\s&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

describe("POST /api/auth/signup", () => {
  it("creates a user, issues a JWT, and emails a verification link", async () => {
    const email = uniqueEmail("signup-ok");
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(false);
    expect(typeof body.token).toBe("string");

    // User row with a password hash exists.
    const user = await getUserByEmail(email);
    expect(user?.passwordHash).toMatch(/^scrypt\$/);

    // Verification email was sent with a link we can extract.
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toBe(email);
    expect(extractLinkToken(sender.sent[0].text)).toBeTruthy();
  });

  it("rejects a short password", async () => {
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: uniqueEmail("shortpw"), password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the email already has a password", async () => {
    const email = uniqueEmail("dup");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "firstsignupok" }),
    });
    const second = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "secondsignupok" }),
    });
    expect(second.status).toBe(409);
  });
});

describe("POST /api/auth/login", () => {
  it("succeeds with correct credentials", async () => {
    const email = uniqueEmail("login-ok");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });

    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(typeof body.token).toBe("string");
  });

  it("fails with wrong password", async () => {
    const email = uniqueEmail("login-badpw");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "rightpassword" }),
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrongpassword" }),
    });
    expect(res.status).toBe(401);
  });

  it("fails with unknown email (same shape as wrong password, no enumeration)", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "whatever123" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/verify-email", () => {
  it("consumes the token and marks email_verified_at", async () => {
    const email = uniqueEmail("verify-ok");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    const token = extractLinkToken(sender.sent[0].text)!;

    const res = await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.emailVerified).toBe(true);

    const user = await getUserByEmail(email);
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it("rejects re-using the same verification token", async () => {
    const email = uniqueEmail("verify-reuse");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correctbattery" }),
    });
    const token = extractLinkToken(sender.sent[0].text)!;

    const first = await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(400);
    const body = await second.json();
    expect(body.reason).toBe("consumed");
  });
});

describe("POST /api/auth/magic-link", () => {
  it("always returns 200 (doesn't leak whether the email exists)", async () => {
    const res = await app.request("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone-totally-new@example.com" }),
    });
    expect(res.status).toBe(200);
    // A token is still issued (signup-on-consume path).
    expect(sender.sent).toHaveLength(1);
  });

  it("consuming the link signs the user in AND marks email_verified_at", async () => {
    const email = uniqueEmail("magic");
    await app.request("/api/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const token = extractLinkToken(sender.sent[0].text)!;

    const res = await app.request("/api/auth/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(true);
    expect(typeof body.token).toBe("string");
  });
});

describe("POST /api/auth/password-reset", () => {
  it("confirm route sets a new password and auto-verifies the email", async () => {
    const email = uniqueEmail("pwreset");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "originalpass" }),
    });
    sender.sent.length = 0; // drop the verification email

    const reqRes = await app.request("/api/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(reqRes.status).toBe(200);
    expect(sender.sent).toHaveLength(1);

    const token = extractLinkToken(sender.sent[0].text)!;
    const confirmRes = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "newstrongpassword" }),
    });
    expect(confirmRes.status).toBe(200);
    const body = await confirmRes.json();
    expect(body.user.emailVerified).toBe(true);

    // Old password no longer works; new one does.
    const oldLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "originalpass" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "newstrongpassword" }),
    });
    expect(newLogin.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("returns 429 after too many login attempts", async () => {
    const email = uniqueEmail("rl");
    await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "rightpassword" }),
    });

    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "wrong" }),
      });
    }
    const blocked = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect(blocked.status).toBe(429);
  });
});

describe("Google SSO (dev-mode fallback)", () => {
  it("issues our JWT and reports emailVerified=true for the dev user", async () => {
    // dev-mode: GOOGLE_CLIENT_ID unset → any idToken gets the dev user.
    await markEmailVerified(
      (await db.insert(users).values({ email: "dev@memex.ai" } as any).onConflictDoNothing().returning())[0]?.id ??
        (await getUserByEmail("dev@memex.ai"))!.id
    ).catch(() => {});

    const res = await app.request("/api/auth/sso/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe("dev@memex.ai");
    expect(body.user.emailVerified).toBe(true);
    expect(typeof body.token).toBe("string");
  });
});
