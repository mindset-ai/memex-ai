// spec-427 t-4 — the single chokepoint every lifecycle/activation (427) email goes
// through. The drip (t-7) and the one-time backlog (t-8) build the EmailMessage and
// decide WHO gets WHICH email WHEN; this function owns HOW a lifecycle email is sent
// safely: it gates on suppression, rides the broadcast stream (t-3), carries the RFC
// 8058 one-click unsubscribe URL (t-4), and uses the team-identity From/Reply-To
// (dec-1) — identical config to the welcome. Keeping this the SOLE lifecycle send path
// is what makes "every 427 send honours suppression + carries List-Unsubscribe" true.

import type { User } from "../../db/schema.js";
import { getEmailSender, type EmailMessage } from "./sender.js";
import { isLifecycleEmailUnsubscribed } from "../users.js";
import { unsubscribeUrl } from "./unsubscribe-token.js";
import { activationEmailsEnabled } from "./activation-flag.js";

// The Postmark broadcast stream id for lifecycle mail. Configurable per env; the
// non-"outbound" value is what routes the send to the broadcast token (t-3).
const BROADCAST_STREAM = process.env.POSTMARK_BROADCAST_STREAM || "broadcast";

/**
 * Send one lifecycle email to a user. Returns true if it was handed to the transport,
 * false if skipped (no email address, or the user has unsubscribed).
 *
 * Suppression is fail-CLOSED: if the suppression read throws, we skip the send rather
 * than risk emailing someone who unsubscribed (respecting an unsubscribe is a legal
 * obligation; missing one drip send is harmless — it retries next run). The caller
 * threads `to`/`userId` from the user, so the message builders don't need them.
 */
export async function sendLifecycleEmail(
  user: Pick<User, "id" | "email">,
  message: EmailMessage,
): Promise<boolean> {
  // spec-427 t-6 (dec-9 / ac-16) — the master + kill switch. Default OFF, so no
  // lifecycle email can send until a human flips ACTIVATION_EMAILS_ENABLED in prod.
  // Enforced here at the sole lifecycle send path (t-7/t-8 also short-circuit earlier).
  if (!activationEmailsEnabled()) return false;
  if (!user.email) return false;

  const suppressed = await isLifecycleEmailUnsubscribed(user.id).catch(() => true);
  if (suppressed) return false;

  await getEmailSender().send({
    ...message,
    to: user.email,
    userId: user.id,
    stream: BROADCAST_STREAM,
    listUnsubscribeUrl: unsubscribeUrl(user.id),
    from: process.env.EMAIL_ACTIVATION_FROM,
    replyTo: process.env.EMAIL_ACTIVATION_REPLY_TO,
  });
  return true;
}
