// spec-427 t-4 (ac-12) — the public unsubscribe endpoint, end-to-end against the DB:
// following the link/token suppresses the user; a tampered token suppresses no one;
// the write is idempotent. Suppression governs LIFECYCLE only — transactional/auth
// email is unaffected (asserted structurally: the flag is a dedicated lifecycle column,
// and isLifecycleEmailUnsubscribed is the only gate sendLifecycleEmail consults).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { isLifecycleEmailUnsubscribed } from "../services/users.js";
import { mintUnsubscribeToken } from "../services/email/unsubscribe-token.js";
import { unsubscribeRouter } from "./unsubscribe.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;

let userId: string;
const EMAIL = "spec427-t4-unsub@example.test";

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: EMAIL }).returning({ id: users.id });
  userId = u!.id;
});
afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

// Hono routers expose .request() — hit the real handler with no session/tenant context,
// exactly as an unauthenticated mail-client one-click would.
const post = (token: string) =>
  unsubscribeRouter.request(`/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST" });
const get = (token: string) =>
  unsubscribeRouter.request(`/unsubscribe?token=${encodeURIComponent(token)}`, { method: "GET" });

describe("POST /api/email/unsubscribe (RFC 8058 one-click)", () => {
  it("suppresses the user on a valid token and returns 200", async () => {
    tagAc(AC(12));
    expect(await isLifecycleEmailUnsubscribed(userId)).toBe(false);
    const res = await post(mintUnsubscribeToken(userId));
    expect(res.status).toBe(200);
    expect(await isLifecycleEmailUnsubscribed(userId)).toBe(true);
  });

  it("is idempotent — a second unsubscribe still 200s and preserves the first timestamp", async () => {
    tagAc(AC(12));
    const [before] = await db
      .select({ at: users.lifecycleEmailUnsubscribedAt })
      .from(users)
      .where(eq(users.id, userId));
    const res = await post(mintUnsubscribeToken(userId));
    expect(res.status).toBe(200);
    const [after] = await db
      .select({ at: users.lifecycleEmailUnsubscribedAt })
      .from(users)
      .where(eq(users.id, userId));
    expect(after!.at?.getTime()).toBe(before!.at?.getTime());
  });
});

describe("unsubscribe endpoint — a forged token suppresses no one", () => {
  let victimId: string;
  const VICTIM = "spec427-t4-victim@example.test";
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: VICTIM }).returning({ id: users.id });
    victimId = u!.id;
  });
  afterAll(async () => {
    if (victimId) await db.delete(users).where(eq(users.id, victimId)).catch(() => {});
  });

  it("400s on a tampered token and leaves the victim subscribed (POST)", async () => {
    tagAc(AC(12));
    const [user, mac] = mintUnsubscribeToken(victimId).split(".");
    const forged = `${user}.${Buffer.from("forged").toString("base64url")}`;
    expect(mac).not.toBe(Buffer.from("forged").toString("base64url"));
    const res = await post(forged);
    expect(res.status).toBe(400);
    expect(await isLifecycleEmailUnsubscribed(victimId)).toBe(false);
  });

  it("GET renders a confirmation page for a valid token and a 400 page for a bad one", async () => {
    tagAc(AC(12));
    const bad = await get("garbage");
    expect(bad.status).toBe(400);
    const ok = await get(mintUnsubscribeToken(victimId));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("unsubscribed");
    expect(await isLifecycleEmailUnsubscribed(victimId)).toBe(true);
  });
});
