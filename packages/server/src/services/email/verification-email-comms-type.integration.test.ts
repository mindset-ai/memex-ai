import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { commsLog, users } from "../../db/schema.js";
import { recordEmailComm } from "../comms-log.js";
import { buildVerificationEmail } from "./templates.js";

// spec-12 t-9 / dec-7 (ac-19): the signup confirmation email must be identifiable in
// comms_log by a distinct, stable comms type — 'email_verification' — so Backstage's
// stuck-signup worklist (t-6) joins on type instead of matching the literal subject.
// Without this it lands as type='transactional' (the default at comms-log.ts), the
// same bucket as password-reset and magic-link, and is indistinguishable.

const AC_VERIFY_TYPE = "mindset-prod/memex-backstage/specs/spec-12/acs/ac-19";

let userId: string;
const EMAIL = "spec12-verify-type@example.com";

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: EMAIL }).returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("spec-12 t-9: verification email carries a distinct comms type (ac-19)", () => {
  it("ac-19: buildVerificationEmail stamps commsType 'email_verification' (not the transactional default)", () => {
    tagAc(AC_VERIFY_TYPE);
    const msg = buildVerificationEmail({ to: EMAIL, verifyUrl: "https://memex.ai/verify?t=abc" });
    expect(msg.commsType).toBe("email_verification");
    expect(msg.commsType).not.toBe("transactional");
  });

  it("ac-19: a recorded verification email lands in comms_log with type='email_verification'", async () => {
    tagAc(AC_VERIFY_TYPE);
    const msg = buildVerificationEmail({ to: EMAIL, verifyUrl: "https://memex.ai/verify?t=abc" });

    const row = await recordEmailComm({
      to: msg.to,
      commsType: msg.commsType,
      subject: msg.subject,
      messageId: "pm-verify-1",
    });

    expect(row, "verification email should record a per-user comm").toBeTruthy();
    expect(row!.type).toBe("email_verification");
    expect(row!.userId).toBe(userId);

    // And it really is in the table with that type (not the transactional default).
    const [stored] = await db
      .select({ type: commsLog.type })
      .from(commsLog)
      .where(eq(commsLog.id, row!.id));
    expect(stored!.type).toBe("email_verification");
  });

  it("ac-19: PostmarkEmailSender threads the template's commsType through to recordEmailComm", async () => {
    tagAc(AC_VERIFY_TYPE);
    // Prove the send path carries the type end-to-end (template → sender → recorder)
    // without a network call: mock recordEmailComm + fetch, send the built message.
    vi.resetModules();
    const recordSpy = vi.fn().mockResolvedValue(null);
    vi.doMock("../comms-log.js", () => ({ recordEmailComm: recordSpy }));
    const { PostmarkEmailSender } = await import("./sender.js");
    const { buildVerificationEmail: build } = await import("./templates.js");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ MessageID: "pm-verify-2" }) }),
    );
    const sender = new PostmarkEmailSender("tok", "Memex <x@memex.ai>");
    await sender.send(build({ to: EMAIL, verifyUrl: "https://memex.ai/verify?t=xyz" }));

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: EMAIL, commsType: "email_verification", messageId: "pm-verify-2" }),
    );
    vi.unstubAllGlobals();
    vi.doUnmock("../comms-log.js");
    vi.resetModules();
  });
});
