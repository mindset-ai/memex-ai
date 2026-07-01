import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { commsLog, users } from "../../db/schema.js";
import { recordEmailComm } from "../comms-log.js";
import { buildMagicLinkEmail, buildPasswordResetEmail } from "./templates.js";

// spec-442 (ac-1 / ac-8): auth emails must carry a precise comms type, set at the
// template write-site so the type travels with the message (mirroring how
// buildVerificationEmail already stamps 'email_verification'). Before this fix the
// magic-link and password-reset builders set no commsType, so recordEmailComm
// defaulted them to 'transactional' — the bucket reserved for genuine non-auth mail.

const AC_TYPE_SCOPE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-1";
const AC_TYPE_TEMPLATE = "mindset-prod/memex-building-itself/specs/spec-442/acs/ac-8";

const MAGIC_EMAIL = "spec442-magic@example.com";
const RESET_EMAIL = "spec442-reset@example.com";
const PLAIN_EMAIL = "spec442-plain@example.com";

let magicUser: string;
let resetUser: string;
let plainUser: string;

beforeAll(async () => {
  const rows = await db
    .insert(users)
    .values([{ email: MAGIC_EMAIL }, { email: RESET_EMAIL }, { email: PLAIN_EMAIL }])
    .returning({ id: users.id, email: users.email });
  magicUser = rows.find((r) => r.email === MAGIC_EMAIL)!.id;
  resetUser = rows.find((r) => r.email === RESET_EMAIL)!.id;
  plainUser = rows.find((r) => r.email === PLAIN_EMAIL)!.id;
});

afterAll(async () => {
  const ids = [magicUser, resetUser, plainUser].filter(Boolean);
  for (const id of ids) await db.delete(users).where(eq(users.id, id)).catch(() => {});
});

describe("spec-442: auth emails carry a precise comms type", () => {
  it("ac-8: buildMagicLinkEmail stamps commsType 'magic_link' (not the transactional default)", () => {
    tagAc(AC_TYPE_TEMPLATE);
    const msg = buildMagicLinkEmail({ to: MAGIC_EMAIL, loginUrl: "https://memex.ai/login?t=abc" });
    expect(msg.commsType).toBe("magic_link");
    expect(msg.commsType).not.toBe("transactional");
  });

  it("ac-8: buildPasswordResetEmail stamps commsType 'password_reset' (not the transactional default)", () => {
    tagAc(AC_TYPE_TEMPLATE);
    const msg = buildPasswordResetEmail({ to: RESET_EMAIL, resetUrl: "https://memex.ai/reset?t=abc" });
    expect(msg.commsType).toBe("password_reset");
    expect(msg.commsType).not.toBe("transactional");
  });

  it("ac-1: a recorded magic-link email lands in comms_log with type='magic_link'", async () => {
    tagAc(AC_TYPE_SCOPE);
    const msg = buildMagicLinkEmail({ to: MAGIC_EMAIL, loginUrl: "https://memex.ai/login?t=xyz" });
    const row = await recordEmailComm({
      to: msg.to,
      commsType: msg.commsType,
      subject: msg.subject,
      messageId: "pm-magic-1",
    });
    expect(row?.type).toBe("magic_link");
    const [stored] = await db
      .select({ type: commsLog.type })
      .from(commsLog)
      .where(eq(commsLog.id, row!.id));
    expect(stored!.type).toBe("magic_link");
  });

  it("ac-1: a recorded password-reset email lands in comms_log with type='password_reset'", async () => {
    tagAc(AC_TYPE_SCOPE);
    const msg = buildPasswordResetEmail({ to: RESET_EMAIL, resetUrl: "https://memex.ai/reset?t=xyz" });
    const row = await recordEmailComm({
      to: msg.to,
      commsType: msg.commsType,
      subject: msg.subject,
      messageId: "pm-reset-1",
    });
    expect(row?.type).toBe("password_reset");
  });

  it("ac-1: 'transactional' stays reserved — an email with no commsType is NOT re-typed as auth", async () => {
    tagAc(AC_TYPE_SCOPE);
    const row = await recordEmailComm({
      to: PLAIN_EMAIL,
      subject: "Your Memex.AI receipt",
      messageId: "pm-plain-1",
    });
    expect(row?.type).toBe("transactional");
  });
});
