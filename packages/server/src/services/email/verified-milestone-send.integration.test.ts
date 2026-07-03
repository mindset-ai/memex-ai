// spec-453 t-2 — the "See it verified" milestone send against the real DB. The
// atomic first-ever gate (UPDATE ... WHERE first_ac_verified_at IS NULL) and the
// lifecycle chokepoint (suppression) are exercised for real; a capturing sender
// stands in for Postmark.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { users, commsLog } from "../../db/schema.js";
import { setEmailSender, type EmailMessage } from "./sender.js";
import { fireVerifiedMilestoneForUser } from "./verified-milestone-send.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

const created: string[] = [];
let sent: EmailMessage[];
const savedEnv = { ...process.env };

async function seedUser(
  email: string,
  opts: { name?: string; firstAcVerifiedAt?: Date | null; unsubscribedAt?: Date | null } = {},
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email,
      name: opts.name ?? null,
      emailVerifiedAt: new Date(),
      firstAcVerifiedAt: opts.firstAcVerifiedAt ?? null,
      lifecycleEmailUnsubscribedAt: opts.unsubscribedAt ?? null,
    })
    .returning({ id: users.id });
  created.push(u!.id);
  return u!.id;
}

async function firstAcVerifiedAt(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: users.firstAcVerifiedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row?.at ?? null;
}

beforeEach(() => {
  sent = [];
  setEmailSender({ send: async (m) => { sent.push(m); } });
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
    await db.delete(users).where(inArray(users.id, created)).catch(() => {});
    created.length = 0;
  }
});

describe("fireVerifiedMilestoneForUser (real DB)", () => {
  it("first-ever verified AC → sends 'See it verified' once, stamps the marker, no re-send [ac-1][ac-9]", async () => {
    tagAc(AC(1));
    tagAc(AC(9));
    const id = await seedUser("v-first@example.test", { name: "Ada Lovelace" });

    await fireVerifiedMilestoneForUser(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("v-first@example.test");
    expect(sent[0]!.commsType).toBe("activation.verified_milestone");
    expect(sent[0]!.html).toContain("Hi Ada,");
    // marker stamped
    expect(await firstAcVerifiedAt(id)).not.toBeNull();

    // A second verified AC for the same user does NOT re-send (atomic gate).
    await fireVerifiedMilestoneForUser(id);
    expect(sent).toHaveLength(1);
  });

  it("flag OFF → no send AND no stamp (a flag-off period never burns the milestone) [ac-9]", async () => {
    tagAc(AC(9));
    delete process.env.ACTIVATION_EMAILS_ENABLED;
    const id = await seedUser("v-flagoff@example.test");
    await fireVerifiedMilestoneForUser(id);
    expect(sent).toHaveLength(0);
    expect(await firstAcVerifiedAt(id)).toBeNull(); // NOT stamped → still eligible once on
  });

  it("pre-existing user (marker already backfilled) → no send [ac-18]", async () => {
    tagAc(AC(18));
    const id = await seedUser("v-preexisting@example.test", { firstAcVerifiedAt: new Date("2026-01-01") });
    await fireVerifiedMilestoneForUser(id);
    expect(sent).toHaveLength(0);
  });

  it("null userId (CI key with no owner / no attribution) → no send, no guess [ac-2]", async () => {
    tagAc(AC(2));
    await fireVerifiedMilestoneForUser(null);
    await fireVerifiedMilestoneForUser(undefined);
    expect(sent).toHaveLength(0);
  });

  it("suppressed (unsubscribed) user → marker consumed, but no send", async () => {
    const id = await seedUser("v-suppressed@example.test", { unsubscribedAt: new Date() });
    await fireVerifiedMilestoneForUser(id);
    expect(sent).toHaveLength(0);
    // The milestone is consumed (stamped) — acceptable, they unsubscribed.
    expect(await firstAcVerifiedAt(id)).not.toBeNull();
  });
});
