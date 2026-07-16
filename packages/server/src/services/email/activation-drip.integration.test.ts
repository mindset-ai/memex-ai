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
// spec-480 amended the win-back orchestration (dec-9/dec-10): signed_in_dormant → the
// video win-back keyed activation.signed_in_dormant; connected_inactive deferred (not sent in v1).
const AC480 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-480/acs/ac-${n}`;
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
  it("connected-inactive is deferred in v1 — nothing sent, nothing logged (spec-480 ac-14, dec-9)", async () => {
    tagAc(AC480(14));
    const u = await seedUser("t7-e1@example.test", { name: "Ada Lovelace" });
    await seedMcpConnected(u.id, daysAgo(3)); // connected 3d ago, no tool call, no spec

    const s1 = await drip([u]);
    // spec-480 dec-9/dec-10: connected_inactive is deferred to a separate later email —
    // it never sends in v1, so the flag-flip's first blast is the win-back alone.
    expect(s1.sent).toBe(0);
    expect(sent).toHaveLength(0);
    const rows = await db.select().from(commsLog).where(eq(commsLog.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("signed-in-dormant past 3d dwell → one win-back, keyed activation.signed_in_dormant, team From/Reply-To, no re-send (ac-2, ac-7, spec-480 ac-13/ac-14)", async () => {
    tagAc(AC(2));
    tagAc(AC(7));
    tagAc(AC480(13));
    tagAc(AC480(14));
    tagAc(AC480(5)); // scope: ships inside the existing send path, recorded in comms_log, no render break
    const u = await seedUser("t7-e2@example.test", { verifiedAt: daysAgo(4) }); // no mcp.connected
    const s = await drip([u]);
    expect(s.sent).toBe(1);
    const m = sent[0]!;
    // spec-480 dec-8: the single stable win-back key; single "Connect your agent" CTA.
    expect(m.commsType).toBe("activation.signed_in_dormant");
    expect(m.html).toContain(">Connect your agent</a>");
    // ac-7: team identity, never a no-reply sender.
    expect(m.from).toBe("The Memex AI team <support@memex.ai>");
    expect(m.replyTo).toBe("support@memex.ai");
    expect(m.from?.toLowerCase()).not.toContain("no-reply");
    expect(m.from?.toLowerCase()).not.toContain("noreply");

    // Recorded under the stable key; a second run dedups → exactly once.
    const rows = await db.select().from(commsLog).where(and(eq(commsLog.userId, u.id), eq(commsLog.type, "activation.signed_in_dormant")));
    expect(rows).toHaveLength(1);
    const s2 = await drip([u]);
    expect(s2.sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("dwell not yet elapsed → nothing sent", async () => {
    const u = await seedUser("t7-fresh@example.test", { verifiedAt: daysAgo(1) });
    const s = await drip([u]);
    expect(s.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("at most one email per run — connected-inactive contributes zero (deferred) (ac-3, spec-480 ac-14)", async () => {
    tagAc(AC(3));
    tagAc(AC480(14));
    const u = await seedUser("t7-excl@example.test");
    await seedMcpConnected(u.id, daysAgo(3));
    await drip([u]);
    // ac-3 exclusivity still holds; for connected_inactive in v1 the count is zero (deferred).
    expect(sent.map((m) => m.commsType)).toEqual([]);
  });

  it("state re-evaluated live: a user who has since connected is deferred, not sent (ac-4, spec-480 ac-14)", async () => {
    tagAc(AC(4));
    tagAc(AC480(14));
    const u = await seedUser("t7-progress@example.test");
    await seedMcpConnected(u.id, daysAgo(3)); // live cohort = connected_inactive
    // spec-480 dec-9: the live re-eval still runs, but connected_inactive is deferred —
    // v1 sends nothing (its "Connect your agent" CTA would be nonsensical here).
    const s = await drip([u]);
    expect(s.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("dedup keys on the stable comms key, NOT the subject line (ac-14, spec-480 ac-13)", async () => {
    tagAc(AC(14));
    tagAc(AC480(13));
    const u = await seedUser("t7-keydedup@example.test", { verifiedAt: daysAgo(4) }); // signed_in_dormant
    // A prior row under the SAME win-back key but a DIFFERENT subject must still suppress.
    await recordComm({ userId: u.id, channel: "email", type: "activation.signed_in_dormant", subject: "a completely different subject" });

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
