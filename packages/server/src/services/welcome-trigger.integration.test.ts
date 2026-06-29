import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { upsertUserByEmail, markEmailVerified } from "./users.js";
import { setEmailSender, type EmailMessage } from "./email/sender.js";

// spec-428 dec-1 (ac-6) — markEmailVerified fires the welcome on the FIRST
// verification, and never a second time (the already-verified early-return).
const AC_TRIGGER = "mindset-prod/memex-building-itself/specs/spec-428/acs/ac-6";

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
    tagAc(AC_TRIGGER);
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
