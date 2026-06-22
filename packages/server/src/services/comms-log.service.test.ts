import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, type Db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { recordComm } from "./comms-log.js";

// spec-6 (memex-backstage) t-2 — the fire-and-forget comms-log emit helper.
//
// ac-9: a comms_log write failure must NOT block, delay, or raise into the
//       caller's send path — the write is advisory (log-and-swallow).
// ac-17: the emit/write path lives in CORE (memex-ai), not Backstage — recordComm
//        writes public.comms_log here, in the core service layer.

const AC_FIRE_AND_FORGET = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-9";
const AC_CORE_WRITE_PATH = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-17";

describe("spec-6 t-2: recordComm is fire-and-forget (ac-9)", () => {
  it("ac-9: a failing insert is swallowed — returns null, never throws", async () => {
    tagAc(AC_FIRE_AND_FORGET);

    // A connection whose insert path rejects, standing in for a DB outage on the
    // send hot path. recordComm must absorb it.
    const throwingConn = {
      insert() {
        return {
          values() {
            return {
              returning() {
                return Promise.reject(new Error("simulated comms_log outage"));
              },
            };
          },
        };
      },
    } as unknown as Db;

    const result = await recordComm(
      { userId: "00000000-0000-0000-0000-000000000000", channel: "email", type: "transactional" },
      throwingConn,
    );
    expect(result, "a write failure must resolve to null, not throw").toBeNull();
  });

  it("ac-9: a comm with no recipient is skipped (returns null, no insert attempted)", async () => {
    tagAc(AC_FIRE_AND_FORGET);

    let insertCalled = false;
    const spyConn = {
      insert() {
        insertCalled = true;
        throw new Error("should not be reached");
      },
    } as unknown as Db;

    const result = await recordComm(
      { userId: "", channel: "in_app", type: "work_notification" },
      spyConn,
    );
    expect(result).toBeNull();
    expect(insertCalled, "no insert should be attempted for an empty userId").toBe(false);
  });
});

describe("spec-6 t-2: recordComm writes public.comms_log in core (ac-17)", () => {
  let userId: string;

  afterAll(async () => {
    // comms_log rows cascade on user delete; remove the throwaway user.
    if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
  });

  it("ac-17: recordComm inserts a comms_log row with the given fields", async () => {
    tagAc(AC_CORE_WRITE_PATH);

    const [u] = await db
      .insert(users)
      .values({ email: "comms-log-t2-test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;

    const row = await recordComm({
      userId,
      channel: "email",
      type: "transactional",
      status: "sent",
      subject: "Your receipt",
      sourceRef: "postmark:abc123",
    });

    expect(row, "happy-path insert should return the row").not.toBeNull();
    expect(row!.userId).toBe(userId);
    expect(row!.channel).toBe("email");
    expect(row!.status).toBe("sent");
    expect(row!.subject).toBe("Your receipt");

    // And it is actually persisted in public.comms_log (the core-owned table).
    const persisted = await db.select().from(commsLog).where(eq(commsLog.userId, userId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sourceRef).toBe("postmark:abc123");
  });
});
