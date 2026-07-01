import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";

// spec-442 (ac-3 / ac-5): the 0120 backfill corrects EXISTING rows. This exercises the
// migration's type-remap UPDATE verbatim against seeded mis-typed rows — auth emails
// that landed as 'transactional' (the old default) must be re-typed by subject, while
// non-auth mail and non-email channels are left untouched. (The sent_at=created_at half
// of the backfill produces the state the ac-7 CHECK then guarantees — that a 'sent' row
// always carries a send time — so its end-state is verified there.)

const AC_BACKFILL_SCOPE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-3";
const AC_TESTS_SCOPE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-5";

const EMAIL = "spec442-backfill@example.com";
let userId: string;
const ids: string[] = [];

// The exact type-remap statement from 0120_spec_442_fix_comms_log_email_tracking.sql.
async function runTypeBackfill(): Promise<void> {
  await db.execute(sql`
    UPDATE "comms_log"
    SET "type" = CASE "subject"
        WHEN 'Confirm your Memex.AI email' THEN 'email_verification'
        WHEN 'Your Memex.AI sign-in link' THEN 'magic_link'
        WHEN 'Reset your Memex.AI password' THEN 'password_reset'
        ELSE "type"
      END
    WHERE "channel" = 'email'
      AND "subject" IN (
        'Confirm your Memex.AI email',
        'Your Memex.AI sign-in link',
        'Reset your Memex.AI password'
      )
  `);
}

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: EMAIL }).returning({ id: users.id });
  userId = u!.id;
  const now = new Date();
  const rows = await db
    .insert(commsLog)
    .values([
      // three auth emails that were mis-typed 'transactional' (sent_at set to satisfy the CHECK)
      { userId, channel: "email", type: "transactional", status: "sent", sentAt: now, subject: "Your Memex.AI sign-in link" },
      { userId, channel: "email", type: "transactional", status: "sent", sentAt: now, subject: "Reset your Memex.AI password" },
      { userId, channel: "email", type: "transactional", status: "sent", sentAt: now, subject: "Confirm your Memex.AI email" },
      // genuine transactional mail — must stay 'transactional'
      { userId, channel: "email", type: "transactional", status: "sent", sentAt: now, subject: "Your Memex.AI receipt" },
      // a non-email channel with a colliding subject — must be left untouched
      { userId, channel: "in_app", type: "work_notification", status: "sent", sentAt: now, subject: "Your Memex.AI sign-in link" },
    ])
    .returning({ id: commsLog.id });
  ids.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  if (ids.length) await db.delete(commsLog).where(inArray(commsLog.id, ids)).catch(() => {});
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

async function typeOf(subject: string, channel: string): Promise<string | undefined> {
  const rows = await db
    .select({ type: commsLog.type, subject: commsLog.subject, channel: commsLog.channel })
    .from(commsLog)
    .where(inArray(commsLog.id, ids));
  return rows.find((r) => r.subject === subject && r.channel === channel)?.type;
}

describe("spec-442: 0120 backfill re-types existing mis-typed auth emails", () => {
  it("ac-3/ac-5: the subject taxonomy is applied to email rows; non-auth and non-email are untouched", async () => {
    tagAc(AC_BACKFILL_SCOPE);
    tagAc(AC_TESTS_SCOPE);

    // Precondition: all three auth emails currently sit in the 'transactional' bucket.
    expect(await typeOf("Your Memex.AI sign-in link", "email")).toBe("transactional");
    expect(await typeOf("Reset your Memex.AI password", "email")).toBe("transactional");
    expect(await typeOf("Confirm your Memex.AI email", "email")).toBe("transactional");

    await runTypeBackfill();

    // Auth emails re-typed by subject…
    expect(await typeOf("Your Memex.AI sign-in link", "email")).toBe("magic_link");
    expect(await typeOf("Reset your Memex.AI password", "email")).toBe("password_reset");
    expect(await typeOf("Confirm your Memex.AI email", "email")).toBe("email_verification");
    // …while genuine transactional mail and the non-email channel are left alone.
    expect(await typeOf("Your Memex.AI receipt", "email")).toBe("transactional");
    expect(await typeOf("Your Memex.AI sign-in link", "in_app")).toBe("work_notification");
  });
});
