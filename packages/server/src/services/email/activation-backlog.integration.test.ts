// spec-427 t-8 — the backlog batch against the real DB. Two things it must get right:
//  1. selectBacklogCandidates targets only signups whose users.created_at predates the
//     go-live cutoff (ac-9);
//  2. running the backlog set through the shared drip sends the correct single email per
//     still-stalled user, skips anyone already carrying the key, and — run a second time
//     (the evergreen hand-off) — re-sends to nobody (ac-5, ac-9).
// The send path is t-7's runActivationDrip over an EXPLICIT candidate set (isolation:
// the whole-table selection is asserted separately, never used to actually send here).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { users, usageEvents, commsLog } from "../../db/schema.js";
import { recordComm, recordEmailComm } from "../comms-log.js";
import { setEmailSender, type EmailMessage } from "./sender.js";
import { runActivationDrip, type CandidateUser } from "./activation-drip.js";
import { selectBacklogCandidates } from "./activation-backlog.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;
const NOW = new Date("2026-06-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const created: string[] = [];
let sent: EmailMessage[];
const savedEnv = { ...process.env };

async function seedUser(
  email: string,
  opts: { createdAt?: Date; verifiedAt?: Date | null; name?: string } = {},
): Promise<CandidateUser> {
  const verifiedAt = "verifiedAt" in opts ? opts.verifiedAt ?? null : new Date();
  const [u] = await db
    .insert(users)
    .values({ email, name: opts.name ?? null, emailVerifiedAt: verifiedAt })
    .returning({ id: users.id, email: users.email, name: users.name });
  created.push(u!.id);
  // created_at defaults to now(); override explicitly when the test needs an age.
  if (opts.createdAt) {
    await db.update(users).set({ createdAt: opts.createdAt }).where(inArray(users.id, [u!.id]));
  }
  return u!;
}
async function seedMcpConnected(userId: string, at: Date, tool = false): Promise<void> {
  const rows = [{ actorUserId: userId, name: "mcp.connected", source: "backend", env: "test", occurredAt: at }];
  if (tool) rows.push({ actorUserId: userId, name: "mcp.tool_called", source: "backend", env: "test", occurredAt: at });
  await db.insert(usageEvents).values(rows);
}

beforeEach(() => {
  sent = [];
  setEmailSender({
    send: async (m) => {
      sent.push(m);
      await recordEmailComm({ to: m.to, userId: m.userId, commsType: m.commsType, subject: m.subject, messageId: `t8-${sent.length}` });
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

describe("selectBacklogCandidates — the go-live cutoff (ac-9)", () => {
  it("includes verified signups before the cutoff; excludes post-cutoff and unverified", async () => {
    tagAc(AC(9));
    const cutoff = daysAgo(10);
    const preVerified = await seedUser("t8-pre@example.test", { createdAt: daysAgo(30) });
    const postCutoff = await seedUser("t8-post@example.test", { createdAt: daysAgo(5) });
    const preUnverified = await seedUser("t8-pre-unverified@example.test", { createdAt: daysAgo(30), verifiedAt: null });

    const ids = (await selectBacklogCandidates(cutoff)).map((c) => c.id);
    expect(ids).toContain(preVerified.id);
    expect(ids).not.toContain(postCutoff.id); // signed up AFTER go-live → drip's job, not backlog
    expect(ids).not.toContain(preUnverified.id); // never verified → not a candidate
  });
});

describe("backlog send over the candidate set (ac-5, ac-9)", () => {
  it("sends the correct single email per still-stalled user; skips already-keyed + activated; no re-fire on the evergreen hand-off", async () => {
    tagAc(AC(5));
    tagAc(AC(9));
    // A — connected-inactive, stalled long ago → Email 1.
    const a = await seedUser("t8-a@example.test", { createdAt: daysAgo(60) });
    await seedMcpConnected(a.id, daysAgo(50));
    // B — signed-in-dormant (verified long ago, never connected) → Email 2.
    const b = await seedUser("t8-b@example.test", { createdAt: daysAgo(60), verifiedAt: daysAgo(60) });
    // D — connected-inactive but ALREADY emailed (carries the key) → skipped.
    const d = await seedUser("t8-d@example.test", { createdAt: daysAgo(60) });
    await seedMcpConnected(d.id, daysAgo(50));
    await recordComm({ userId: d.id, channel: "email", type: "activation.connected_inactive", subject: "sent earlier" });
    // E — activated (called a tool) → no cohort, nothing.
    const e = await seedUser("t8-e@example.test", { createdAt: daysAgo(60) });
    await seedMcpConnected(e.id, daysAgo(50), true);

    const backlog = [a, b, d, e];
    const s1 = await runActivationDrip(NOW, undefined, backlog);
    expect(s1.sent).toBe(2);
    const byUser = new Map(sent.map((m) => [m.to, m.commsType]));
    expect(byUser.get(a.email!)).toBe("activation.connected_inactive");
    expect(byUser.get(b.email!)).toBe("activation.signed_in_dormant");
    expect(byUser.has(d.email!)).toBe(false); // already emailed
    expect(byUser.has(e.email!)).toBe(false); // activated

    // Evergreen hand-off: switching the daily drip on afterwards must NOT re-send to
    // anyone the backlog already emailed (they now all carry their key).
    sent = [];
    const s2 = await runActivationDrip(NOW, undefined, backlog);
    expect(s2.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
