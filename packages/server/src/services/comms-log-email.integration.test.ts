import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { recordEmailComm } from "./comms-log.js";

// spec-341 t-1 — recordEmailComm: how an email send lands in the comms log.
// ac-1: recorded with recipient/channel/type/subject. ac-2: carries the Postmark
// MessageID (source_ref). ac-5/ac-11 (dec-4 → B): resolve user (passed or by
// email), skip non-users, advisory (never throws).

const AC_RECORDED = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-1";
const AC_MESSAGE_ID = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-2";
const AC_NEVER_FAILS = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-5";
const AC_RESOLVE = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-11";

let userId: string;
const EMAIL = "email-comms-t1@example.com";

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: EMAIL }).returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-341 t-1: recordEmailComm (ac-1/2/11)", () => {
  it("ac-1/ac-2/ac-11: resolves the recipient by email and records channel/type/subject + MessageID", async () => {
    tagAc(AC_RECORDED);
    tagAc(AC_MESSAGE_ID);
    tagAc(AC_RESOLVE);

    const row = await recordEmailComm({
      to: EMAIL,
      commsType: "activation",
      subject: "Welcome to Memex",
      messageId: "pm-welcome-1",
    });
    expect(row, "a known recipient is recorded").not.toBeNull();
    expect(row!.userId).toBe(userId);
    expect(row!.channel).toBe("email");
    expect(row!.type).toBe("activation");
    expect(row!.subject).toBe("Welcome to Memex");
    expect(row!.sourceRef, "Postmark MessageID stored as source_ref (ac-2)").toBe("pm-welcome-1");
  });

  it("ac-11: a passed userId is used directly (no email lookup needed); type defaults to transactional", async () => {
    tagAc(AC_RESOLVE);
    const row = await recordEmailComm({ to: "irrelevant@example.com", userId, subject: "Receipt" });
    expect(row!.userId).toBe(userId);
    expect(row!.type).toBe("transactional");
  });

  it("ac-11: an email to a non-user is skipped (returns null, no row)", async () => {
    tagAc(AC_RESOLVE);
    const row = await recordEmailComm({ to: "stranger-not-a-user@nowhere.test", subject: "Invite" });
    expect(row).toBeNull();
  });

  it("ac-5: recording is advisory — a failure is swallowed, never thrown", async () => {
    tagAc(AC_NEVER_FAILS);
    // A broken connection stand-in: .select() throws. recordEmailComm must swallow.
    const brokenConn = {
      select() {
        throw new Error("simulated DB outage");
      },
    } as unknown as typeof db;
    const row = await recordEmailComm({ to: EMAIL, subject: "x" }, brokenConn);
    expect(row).toBeNull();
  });
});
