// Email-sending abstraction.
//
//   * Dev: ConsoleEmailSender prints to stdout — copy the link from the terminal.
//   * Prod: PostmarkEmailSender uses the Postmark HTTP API. Set POSTMARK_SERVER_TOKEN
//     and EMAIL_FROM (e.g. "Memex.AI <support@memex.ai>").
//
// The selection happens lazily in getEmailSender() based on env. Tests can override
// via setEmailSender().

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log("");
    console.log(`────────── [email] to=${message.to} ──────────`);
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
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.token,
      },
      body: JSON.stringify({
        From: this.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        MessageStream: "outbound",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `Postmark send failed (${res.status}) to=${message.to}: ${body}`
      );
    }
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
    cached = new PostmarkEmailSender(postmarkToken, from);
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
