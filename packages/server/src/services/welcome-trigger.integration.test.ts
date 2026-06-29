import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { upsertUserByEmail, markEmailVerified } from "./users.js";
import { setEmailSender, type EmailMessage } from "./email/sender.js";

// spec-428 — markEmailVerified fires the welcome on the FIRST verification (ac-6),
// via the SSO/magic-link `upsertUserByEmail` row not the account.created event
// (ac-7), once per user (ac-1), and never a second time (already-verified return).
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-428/acs/ac-${n}`;

let sent: EmailMessage[];
beforeEach(() => {
  sent = [];
  setEmailSender({
    send: async (m) => {
      sent.push(m);
    },
  });
});
afterEach(() => setEmailSender(null));

async function waitForSend(): Promise<void> {
  // sendWelcomeEmail is void-fired (advisory) from markEmailVerified — poll for it.
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("welcome trigger via markEmailVerified", () => {
  it("fires exactly one welcome on first verification and none on a repeat", async () => {
    tagAc(AC(6)); // fires on the email-verified transition
    tagAc(AC(7)); // upsertUserByEmail is the SSO/magic-link path — no account.created
    tagAc(AC(1)); // the user receives the welcome
    const email = `welcome-trigger-${Date.now()}@example.test`;
    const user = await upsertUserByEmail(email);

    await markEmailVerified(user.id);
    await waitForSend();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.commsType).toBe("welcome");
    expect(sent[0]!.to).toBe(email);

    // A second verify is a no-op (already verified) → no second welcome.
    await markEmailVerified(user.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);
  });
});
