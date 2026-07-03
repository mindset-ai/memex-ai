// spec-453 t-2 — the "See it verified" trigger wired into the /api/test-events
// ingest path. Drives the REAL route against real Postgres, only the emission-key
// auth is mocked (so we can control the key's OWNER). Proves: the milestone is
// attributed to the emission key's createdByUserId (dec-9), NOT the free-form
// test_events.actor; and the hook is a standalone, fire-and-forget add-on that
// leaves the 201 intact and sends nothing when the key has no owner (dec-4).
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Holder set at request time so the mocked auth agrees with resolveMemexId and we
// can steer WHO owns the key per test.
const h = vi.hoisted(() => ({ memexId: "", createdByUserId: null as string | null }));

vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi.fn(async () => ({
    id: "test-key",
    memexId: h.memexId,
    scopedSpecHandle: null,
    createdByUserId: h.createdByUserId,
  })),
  resolveMemexId: vi.fn(async () => h.memexId),
  bumpLastUsed: vi.fn(),
}));

import { db } from "../db/connection.js";
import { users, commsLog, testEvents, testEventLatest, acFirstVerified, namespaces } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { setEmailSender, type EmailMessage } from "../services/email/sender.js";
import { testEventsRouter } from "./test-events.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let slug: string;
const createdUserIds: string[] = [];
const createdRefs: string[] = [];
let sent: EmailMessage[];
const savedEnv = { ...process.env };

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s453");
  h.memexId = made.memexId;
  slug = made.slug;
});

afterAll(async () => {
  if (createdRefs.length) {
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(acFirstVerified).where(inArray(acFirstVerified.subjectRef, createdRefs)).catch(() => {});
  }
  if (slug) await db.delete(namespaces).where(eq(namespaces.slug, slug)).catch(() => {});
});

beforeEach(() => {
  sent = [];
  h.createdByUserId = null;
  setEmailSender({ send: async (m) => { sent.push(m); } });
  process.env.ACTIVATION_EMAILS_ENABLED = "1";
  process.env.APP_BASE_URL = "https://int.memex.ai";
  process.env.EMAIL_ACTIVATION_FROM = "The Memex AI team <support@memex.ai>";
  process.env.EMAIL_ACTIVATION_REPLY_TO = "support@memex.ai";
});
afterEach(async () => {
  setEmailSender(null);
  process.env = { ...savedEnv };
  if (createdUserIds.length) {
    await db.delete(commsLog).where(inArray(commsLog.userId, createdUserIds)).catch(() => {});
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
    createdUserIds.length = 0;
  }
});

async function seedUser(email: string, name?: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email, name: name ?? null, emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  createdUserIds.push(u!.id);
  return u!.id;
}

let refCounter = 0;
async function emitPass(actor?: string): Promise<Response> {
  const subjectRef = `${slug}/main/specs/spec-1/acs/ac-${++refCounter}`;
  createdRefs.push(subjectRef);
  return app.request("/api/test-events", {
    method: "POST",
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: JSON.stringify({ ac_uid: subjectRef, status: "pass", test_identifier: "spec-453.trigger", ...(actor ? { actor } : {}) }),
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
}

describe("spec-453: 'See it verified' trigger on /api/test-events", () => {
  it("attributes the milestone to the emission key's OWNER, never the actor [ac-12]", async () => {
    tagAc(AC(12));
    const ownerId = await seedUser("v-owner@example.test", "Ada Lovelace");
    // A different person's name is posted as the free-form actor — it must be ignored.
    await seedUser("v-actor@example.test", "Someone Else");
    h.createdByUserId = ownerId;

    const res = await emitPass("Someone Else");
    expect(res.status).toBe(201); // hot path intact

    await waitFor(() => sent.length >= 1);
    expect(sent).toHaveLength(1);
    // The email goes to the KEY OWNER, not to the actor string.
    expect(sent[0]!.to).toBe("v-owner@example.test");
    expect(sent[0]!.commsType).toBe("activation.verified_milestone");
    // Owner's marker is stamped.
    const [row] = await db.select({ at: users.firstAcVerifiedAt }).from(users).where(eq(users.id, ownerId));
    expect(row!.at).not.toBeNull();
  });

  it("key with no owner → 201 as always, and NO milestone email (standalone hook declines to guess) [ac-16]", async () => {
    tagAc(AC(16));
    h.createdByUserId = null; // CI key with no member owner

    const res = await emitPass();
    expect(res.status).toBe(201); // the standalone hook never affects ingestion

    // Give the fire-and-forget a beat; it must have sent nothing.
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0);
  });
});
