// spec-428 t-3 — fire the day-one welcome on the email-verified transition.
//
// Called from markEmailVerified (the single chokepoint all three auth paths hit:
// SSO, magic-link, email+password) on the FIRST verification. Advisory + idempotent
// so it can never break verification and never sends twice.

import type { User } from "../../db/schema.js";
import { getEmailSender } from "./sender.js";
import { buildWelcomeEmail } from "./templates.js";
import { hasComm } from "../comms-log.js";

const WELCOME_KEY = "welcome";

/**
 * Send the welcome to a freshly email-verified user.
 *  - Advisory (spec-428 dec-1): any failure is swallowed — a welcome must never
 *    break or delay the verification flow.
 *  - Idempotent (dec-7): skips when the user already has a `welcome` comms_log row.
 *  - Transactional / always-sends: NOT gated by ACTIVATION_EMAILS_ENABLED (that
 *    flag governs the spec-427 drip only).
 * The CTA url derives from APP_BASE_URL (int → int.memex.ai, prod → memex.ai); the
 * named-human From + monitored Reply-To come from config (dec-1 / std-31), absent →
 * the transport's default From and no Reply-To.
 */
export async function sendWelcomeEmail(
  user: Pick<User, "id" | "email" | "name">,
): Promise<void> {
  try {
    if (!user.email) return;
    if (await hasComm(user.id, WELCOME_KEY)) return;

    const appUrl = process.env.APP_BASE_URL ?? "https://memex.ai";
    const firstName = user.name?.trim().split(/\s+/)[0] || undefined;

    const message = buildWelcomeEmail({
      to: user.email,
      appUrl,
      firstName,
      senderName: process.env.EMAIL_SENDER_NAME,
    });

    await getEmailSender().send({
      ...message,
      userId: user.id,
      from: process.env.EMAIL_ACTIVATION_FROM,
      replyTo: process.env.EMAIL_ACTIVATION_REPLY_TO,
    });
  } catch (err) {
    console.error(
      "[welcome-send] failed (swallowed):",
      err instanceof Error ? err.message : err,
    );
  }
}
