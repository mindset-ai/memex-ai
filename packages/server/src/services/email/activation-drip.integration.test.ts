// spec-427 t-7 — the daily drip against the real DB: cohort state (t-5) is derived
// live, the send rides the real lifecycle chokepoint (t-4), and dedup reads the
// comms_log the chokepoint writes. A capturing sender stands in for Postmark and, like
// the real PostmarkEmailSender, records each send into comms_log via recordEmailComm —
// so the exactly-once / dedup contract is exercised end-to-end (write → read → skip).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { users, usageEvents, commsLog } from "../../db/schema.js";
import { recordComm, recordEmailComm } from "../comms-log.js";
import { setEmailSender, type EmailMessage } from "./sender.js";
import { runActivationDrip, selectActivationCandidates, type CandidateUser } from "./activation-drip.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;
const NOW = new Date("2026-06-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const created: string[] = [];
let sent: EmailMessage[];
const savedEnv = { ...process.env };

async function seedUser(
  email: string,
  opts: { verifiedAt?: Date | null; name?: string } = {},
): Promise<CandidateUser> {
  // NB: distinguish "not passed" (→ verified now) from an explicit null (→ unverified);
  // `?? new Date()` would wrongly verify an explicit-null user.
  const verifiedAt = "verifiedAt" in opts ? opts.verifiedAt ?? null : new Date();
  const [u] = await db
    .insert(users)
    .values({ email, name: opts.name ?? null, emailVerifiedAt: verifiedAt })
    .returning({ id: users.id, email: users.email, name: users.name });
  created.push(u!.id);
  return u!;
}
async function seedMcpConnected(userId: string, at: Date): Promise<void> {
  await db.insert(usageEvents).values({ actorUserId: userId, name: "mcp.connected", source: "backend", env: "test", occurredAt: at });
}
/** One captured send (only my seeded users are ever passed to the drip → no cross-test bleed). */
async function drip(candidates: CandidateUser[]) {
  return runActivationDrip(NOW, undefined, candidates);
}

beforeEach(() => {
  sent = [];
  // Stand in for Postmark AND mirror its comms_log recording (sender.ts:139) so dedup
  // across runs is exercised for real.
  setEmailSender({
    send: async (m) => {
      sent.push(m);
      await recordEmailComm({ to: m.to, userId: m.userId, commsType: m.commsType, subject: m.subject, messageId: `t7-${sent.length}` });
    },
  });
  process.env.ACTIVATION_EMAILS_ENABLED = "1";
  process.env.APP_BASE_URL = "https://int.memex.ai";
  process.env.EMAIL_ACTIVATION_FROM = "The Memex AI team <support@memex.ai>";
  process.env.EMAIL_ACTIVATION_REPLY_TO = "support@memex.ai";
});
afterEach(async () => {
  setEmailSender(null);
  process.env = { ...savedEnv };
  if (created.length) {
    await db.delete(commsLog).where(inArray(commsLog.userId, created)).catch(() => {});
    await db.delete(usageEvents).where(inArray(usageEvents.actorUserId, created)).catch(() => {});
    await db.delete(users).where(inArray(users.id, created)).catch(() => {});
    created.length = 0;
  }
});

describe("runActivationDrip (real DB)", () => {
  it("connected-inactive past 2d dwell → exactly one Email 1, recorded under its stable key; team From/Reply-To; no re-send (ac-1, ac-7, ac-14)", async () => {
    tagAc(AC(1));
    tagAc(AC(7));
    tagAc(AC(14));
    const u = await seedUser("t7-e1@example.test", { name: "Ada Lovelace" });
    await seedMcpConnected(u.id, daysAgo(3)); // connected 3d ago, no tool call, no spec

    const s1 = await drip([u]);
    expect(s1.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.commsType).toBe("activation.connected_inactive");
    expect(m.to).toBe(u.email);
    // ac-7: team identity, never a no-reply sender.
    expect(m.from).toBe("The Memex AI team <support@memex.ai>");
    expect(m.replyTo).toBe("support@memex.ai");
    expect(m.from?.toLowerCase()).not.toContain("no-reply");
    expect(m.from?.toLowerCase()).not.toContain("noreply");

    // Recorded in comms_log under the stable key (ac-1 / ac-14).
    const rows = await db.select().from(commsLog).where(and(eq(commsLog.userId, u.id), eq(commsLog.type, "activation.connected_inactive")));
    expect(rows).toHaveLength(1);

    // Second run: dedup reads that row → exactly once (ac-1).
    const s2 = await drip([u]);
    expect(s2.sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("signed-in-dormant past 3d dwell → exactly one Email 2 (ac-2)", async () => {
    tagAc(AC(2));
    const u = await seedUser("t7-e2@example.test", { verifiedAt: daysAgo(4) }); // no mcp.connected
    const s = await drip([u]);
    expect(s.sent).toBe(1);
    expect(sent[0]!.commsType).toBe("activation.signed_in_dormant");
  });

  it("dwell not yet elapsed → nothing sent", async () => {
    const u = await seedUser("t7-fresh@example.test", { verifiedAt: daysAgo(1) });
    const s = await drip([u]);
    expect(s.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a connected-inactive user gets Email 1 only — never both in a run (ac-3)", async () => {
    tagAc(AC(3));
    const u = await seedUser("t7-excl@example.test");
    await seedMcpConnected(u.id, daysAgo(3));
    await drip([u]);
    expect(sent.map((m) => m.commsType)).toEqual(["activation.connected_inactive"]);
  });

  it("state re-evaluated live: carries the E2 key from before, now connected → sends E1, not a repeat (ac-4)", async () => {
    tagAc(AC(4));
    const u = await seedUser("t7-progress@example.test");
    await seedMcpConnected(u.id, daysAgo(3)); // live cohort = connected_inactive
    // They were emailed as signed-in-dormant earlier — seed that comms_log key.
    await recordComm({ userId: u.id, channel: "email", type: "activation.signed_in_dormant", subject: "old" });

    const s = await drip([u]);
    expect(s.sent).toBe(1);
    expect(sent[0]!.commsType).toBe("activation.connected_inactive"); // next-state email, not a repeat
  });

  it("dedup keys on the stable comms key, NOT the subject line (ac-14)", async () => {
    tagAc(AC(14));
    const u = await seedUser("t7-keydedup@example.test");
    await seedMcpConnected(u.id, daysAgo(3));
    // A prior row under the SAME key but a DIFFERENT subject must still suppress.
    await recordComm({ userId: u.id, channel: "email", type: "activation.connected_inactive", subject: "a completely different subject" });

    const s = await drip([u]);
    expect(s.sent).toBe(0); // deduped by key despite the mismatched subject
    expect(sent).toHaveLength(0);
  });

  it("selectActivationCandidates includes verified users and excludes unverified ones", async () => {
    const verified = await seedUser("t7-cand-verified@example.test", { verifiedAt: daysAgo(1) });
    const unverified = await seedUser("t7-cand-unverified@example.test", { verifiedAt: null });
    const ids = (await selectActivationCandidates()).map((c) => c.id);
    expect(ids).toContain(verified.id);
    expect(ids).not.toContain(unverified.id);
  });
});
