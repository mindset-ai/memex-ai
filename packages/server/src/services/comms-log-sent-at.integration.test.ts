import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { commsLog, users } from "../db/schema.js";
import { recordComm, recordEmailComm } from "./comms-log.js";

// spec-442 (ac-2 / ac-4 / ac-6 / ac-7 / ac-9): the invariant status='sent' ⇒ sent_at
// IS NOT NULL. Before this fix the send path inserted status='sent' with sent_at NULL
// on every email. recordComm now stamps sent_at (real Postmark SubmittedAt when
// threaded, else now()) for any 'sent' row, and a DB CHECK backstops it.

const AC_SENT_SCOPE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-2";
const AC_GUARD_SCOPE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-4";
const AC_STAMP_IMPL = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-6";
const AC_CHECK_IMPL = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-7";
const AC_DEFAULT_IMPL = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-9";

const EMAIL = "spec442-sentat@example.com";
let userId: string;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: EMAIL }).returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-442: sent_at is stamped whenever status='sent'", () => {
  it("ac-9/ac-2: a 'sent' insert with no explicit sentAt gets sent_at ≈ now()", async () => {
    tagAc(AC_DEFAULT_IMPL);
    tagAc(AC_SENT_SCOPE);
    const before = Date.now();
    const row = await recordComm({
      userId,
      channel: "email",
      type: "transactional",
      status: "sent",
      subject: "no sentAt supplied",
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    const stamped = row!.sentAt!.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("ac-6: an explicitly threaded sentAt (Postmark SubmittedAt) is used verbatim", async () => {
    tagAc(AC_STAMP_IMPL);
    const submitted = new Date("2026-06-01T12:34:56.000Z");
    const row = await recordComm({
      userId,
      channel: "email",
      type: "transactional",
      status: "sent",
      sentAt: submitted,
      subject: "explicit sentAt",
    });
    expect(row?.sentAt?.toISOString()).toBe(submitted.toISOString());
  });

  it("ac-6: recordEmailComm threads sentAt through to the stored row", async () => {
    tagAc(AC_STAMP_IMPL);
    const submitted = new Date("2026-05-15T09:00:00.000Z");
    const row = await recordEmailComm({
      to: EMAIL,
      commsType: "magic_link",
      subject: "Your Memex.AI sign-in link",
      messageId: "pm-sentat-1",
      sentAt: submitted,
    });
    expect(row?.sentAt?.toISOString()).toBe(submitted.toISOString());
  });

  it("ac-4: a 'scheduled' row keeps sent_at NULL (the invariant only binds 'sent')", async () => {
    tagAc(AC_GUARD_SCOPE);
    const row = await recordComm({
      userId,
      channel: "email",
      type: "transactional",
      status: "scheduled",
      scheduledFor: new Date("2027-01-01T00:00:00.000Z"),
      subject: "scheduled, not yet sent",
    });
    expect(row?.status).toBe("scheduled");
    expect(row?.sentAt).toBeNull();
  });

  it("ac-6: PostmarkEmailSender parses SubmittedAt from the response and threads it as sentAt", async () => {
    tagAc(AC_STAMP_IMPL);
    vi.resetModules();
    const recordSpy = vi.fn().mockResolvedValue(null);
    // sender.ts (src/services/email/) imports recordEmailComm from "../comms-log.js",
    // which resolves to src/services/comms-log.js — the same module this test reaches
    // via "./comms-log.js". Mocking that path swaps the recorder the sender calls.
    vi.doMock("./comms-log.js", () => ({ recordEmailComm: recordSpy }));
    const { PostmarkEmailSender } = await import("./email/sender.js");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ MessageID: "pm-sentat-2", SubmittedAt: "2026-06-23T10:11:12.000Z" }),
      }),
    );
    const sender = new PostmarkEmailSender("tok", "Memex <x@memex.ai>");
    await sender.send({ to: EMAIL, subject: "Your Memex.AI sign-in link", text: "hi", commsType: "magic_link" });

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "pm-sentat-2",
        sentAt: new Date("2026-06-23T10:11:12.000Z"),
      }),
    );
    vi.unstubAllGlobals();
    vi.doUnmock("./comms-log.js");
    vi.doUnmock("../services/comms-log.js");
    vi.resetModules();
  });

  it("ac-7/ac-4: the DB CHECK rejects a raw status='sent' / sent_at=NULL insert", async () => {
    tagAc(AC_CHECK_IMPL);
    tagAc(AC_GUARD_SCOPE);
    // Bypass recordComm's stamping and insert straight to the table — the DB CHECK
    // is the backstop that must fire. Drizzle wraps the driver error, so the
    // constraint name rides on the underlying PostgresError (err.cause).
    let caught: unknown;
    await db
      .insert(commsLog)
      .values({
        userId,
        channel: "email",
        type: "transactional",
        status: "sent",
        sentAt: null,
        subject: "raw insert bypassing recordComm's stamping",
      })
      .catch((e: unknown) => {
        caught = e;
      });
    expect(caught, "a raw status='sent'/sent_at=NULL insert must be rejected").toBeDefined();
    const cause = (caught as { cause?: { message?: string; constraint_name?: string; code?: string } })?.cause;
    expect(cause?.code).toBe("23514"); // check_violation
    expect(`${cause?.constraint_name} ${cause?.message}`).toContain("comms_log_sent_requires_sent_at");
  });
});
