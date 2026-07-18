// Email-sending abstraction.
//
//   * Dev: ConsoleEmailSender prints to stdout — copy the link from the terminal.
//   * Prod: PostmarkEmailSender uses the Postmark HTTP API. Set POSTMARK_SERVER_TOKEN
//     and EMAIL_FROM (e.g. "Memex.AI <support@memex.ai>").
//
// The selection happens lazily in getEmailSender() based on env. Tests can override
// via setEmailSender().
import { recordEmailComm } from "../comms-log.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  // spec-341 (dec-4 → B): optional comms-log context. `userId` attributes the
  // email to a user directly (else it's resolved from `to`); `commsType` labels
  // it in the log (e.g. 'transactional' | 'activation'). Both optional — an email
  // sent without them is still recorded, resolved by recipient address.
  userId?: string;
  commsType?: string;
  // spec-428 dec-3 / spec-427 dec-1 — per-message sender overrides for the
  // activation/welcome emails: a named-human `from` and a monitored `replyTo`
  // inbox, distinct from the default transactional sender. Both optional; absent
  // → the configured default From and no Reply-To (the existing 6 emails unchanged).
  from?: string;
  replyTo?: string;
  // spec-427 t-3 (dec-5/dec-8) — the lifecycle/broadcast transport. `stream` is the
  // Postmark MessageStream id; absent → "outbound" (the transactional stream all
  // existing emails use, unchanged). Any non-"outbound" stream is a broadcast/
  // lifecycle send: it selects the broadcast token (int-safe sandbox by default,
  // real in prod) rather than the transactional token. `listUnsubscribeUrl`, when
  // present, emits the RFC 8058 one-click List-Unsubscribe header pair (the token
  // in the URL is issued by t-4).
  stream?: string;
  listUnsubscribeUrl?: string;
  // spec-480 dec-6 (ac-11) — enable Postmark click tracking for this message. When true,
  // Postmark rewrites the HTML+text links through its redirect so a click fires a `Click`
  // webhook event (recorded in comms_log via the spec-341 webhook), the only way to
  // attribute a click on a raw-mp4/GCS link (which can't run JS). Absent → no rewriting
  // (the default for every other email — links stay pristine). NB: this is click tracking
  // ONLY, not open tracking — no invisible pixel is injected, keeping the email's single
  // intentional image (the thumbnail) the only image.
  trackLinks?: boolean;
}

// The transactional stream every existing email rides. A message with no `stream`
// (or this exact value) takes the transactional token; anything else is broadcast.
const TRANSACTIONAL_STREAM = "outbound";
// Postmark's well-known sandbox token literal — accepts, returns 200, delivers
// nothing, no reputation impact. The fail-safe default for the broadcast path so a
// deploy that forgets POSTMARK_BROADCAST_TOKEN (e.g. int) can never send real
// broadcast mail (spec-427 dec-8 / ac-15).
const POSTMARK_TEST_TOKEN = "POSTMARK_API_TEST";

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log("");
    console.log(`────────── [email] to=${message.to} ──────────`);
    if (message.from) console.log(`from: ${message.from}`);
    if (message.replyTo) console.log(`reply-to: ${message.replyTo}`);
    console.log(`subject: ${message.subject}`);
    console.log("");
    console.log(message.text);
    console.log(`────────── [/email] ──────────`);
    console.log("");
  }
}

// Postmark HTTP API sender — no SDK dependency, just a single fetch call.
// Docs: https://postmarkapp.com/developer/api/email-api
export class PostmarkEmailSender implements EmailSender {
  constructor(
    private readonly token: string,
    private readonly from: string,
    // spec-427 t-3 — the token used for broadcast/lifecycle sends. Distinct from the
    // transactional `token` so int can deliver nothing (sandbox) while prod uses the
    // real token; the transactional path always uses `token`. Absent → the broadcast
    // path falls back to the shared `token`.
    private readonly broadcastToken?: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const stream = message.stream ?? TRANSACTIONAL_STREAM;
    // Non-transactional streams are lifecycle/broadcast: select the broadcast token
    // (int-safe sandbox / prod real). Transactional sends always use the shared token.
    const token =
      stream === TRANSACTIONAL_STREAM ? this.token : this.broadcastToken ?? this.token;
    // spec-427 t-3 (ac-11) — RFC 8058 one-click unsubscribe. The URL MUST be
    // angle-bracket wrapped (RFC 2369) or clients won't honour one-click.
    const headers = message.listUnsubscribeUrl
      ? [
          { Name: "List-Unsubscribe", Value: `<${message.listUnsubscribeUrl}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ]
      : undefined;

    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: message.from ?? this.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
        ...(headers ? { Headers: headers } : {}),
        // spec-480 dec-6 (ac-11): click tracking only (never TrackOpens — no pixel).
        ...(message.trackLinks ? { TrackLinks: "HtmlAndText" } : {}),
        MessageStream: stream,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `Postmark send failed (${res.status}) to=${message.to}: ${body}`
      );
    }

    // spec-341 t-1: record the email in the comms log, fire-and-forget. Capture
    // the Postmark MessageID (source_ref) so the delivery webhook can match it.
    // recordEmailComm is advisory (swallows its own errors); a logging fault must
    // never affect the send, so we also guard the response parse and never await
    // into the caller's failure path.
    let messageId: string | undefined;
    let sentAt: Date | undefined;
    try {
      const body = (await res.json()) as { MessageID?: string; SubmittedAt?: string };
      messageId = body.MessageID;
      // spec-442 (ac-6): use Postmark's SubmittedAt as the true send time when present
      // and parseable; otherwise leave it undefined and let recordComm fall back to now().
      if (body.SubmittedAt) {
        const parsed = new Date(body.SubmittedAt);
        if (!Number.isNaN(parsed.getTime())) sentAt = parsed;
      }
    } catch {
      // response parse is best-effort — proceed to record without a MessageID / send time
    }
    void recordEmailComm({
      to: message.to,
      userId: message.userId,
      commsType: message.commsType,
      subject: message.subject,
      messageId,
      sentAt,
    });
  }
}

export class NotConfiguredEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    throw new Error(
      `Email sender not configured. Cannot deliver to ${message.to}. Set POSTMARK_SERVER_TOKEN + EMAIL_FROM, or setEmailSender() in tests.`
    );
  }
}

let cached: EmailSender | null = null;

// Returns the configured sender. Selection rules:
//   1. If POSTMARK_SERVER_TOKEN + EMAIL_FROM are set → PostmarkEmailSender.
//   2. Else if NODE_ENV=production → NotConfiguredEmailSender (throws on send, fails loudly
//      so operators notice missing config before emails silently drop).
//   3. Otherwise → ConsoleEmailSender (dev default).
export function getEmailSender(): EmailSender {
  if (cached) return cached;

  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (postmarkToken && from) {
    // spec-427 dec-8 / ac-15 — fail-safe: the broadcast token defaults to Postmark's
    // sandbox literal, so an env that never sets POSTMARK_BROADCAST_TOKEN (int)
    // delivers no real broadcast mail. Prod sets it to the real token to opt in.
    const broadcastToken = process.env.POSTMARK_BROADCAST_TOKEN || POSTMARK_TEST_TOKEN;
    cached = new PostmarkEmailSender(postmarkToken, from, broadcastToken);
    return cached;
  }

  const isProd = process.env.NODE_ENV === "production";
  cached = isProd ? new NotConfiguredEmailSender() : new ConsoleEmailSender();
  return cached;
}

// Test/override hook
export function setEmailSender(sender: EmailSender | null): void {
  cached = sender;
}
