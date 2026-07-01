// spec-427 t-4 — the lifecycle send chokepoint: gates on suppression (ac-12), rides
// the broadcast stream + carries the one-click List-Unsubscribe URL (ac-11), and uses
// the team-identity From/Reply-To (dec-1). The suppression read is mocked so this is a
// pure unit test of the chokepoint's behaviour.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;

// Control the suppression gate without a DB.
const isSuppressed = vi.fn<(id: string) => Promise<boolean>>();
vi.mock("../users.js", () => ({ isLifecycleEmailUnsubscribed: (id: string) => isSuppressed(id) }));

import { sendLifecycleEmail } from "./lifecycle-send.js";
import { setEmailSender, type EmailMessage } from "./sender.js";

const USER = { id: "11111111-1111-1111-1111-111111111111", email: "u@example.test" };
const MSG: EmailMessage = { to: "", subject: "Create your first Spec", text: "body", commsType: "activation.connected_inactive" };

let sent: EmailMessage[];
const savedEnv = { ...process.env };

beforeEach(() => {
  sent = [];
  setEmailSender({ send: async (m) => { sent.push(m); } });
  process.env.APP_BASE_URL = "https://int.memex.ai";
  process.env.EMAIL_ACTIVATION_FROM = "The Memex AI team <support@memex.ai>";
  process.env.EMAIL_ACTIVATION_REPLY_TO = "support@memex.ai";
});
afterEach(() => {
  setEmailSender(null);
  process.env = { ...savedEnv };
  vi.clearAllMocks();
});

describe("sendLifecycleEmail", () => {
  it("sends a subscribed user on the broadcast stream with a List-Unsubscribe URL + team identity", async () => {
    tagAc(AC(11));
    isSuppressed.mockResolvedValue(false);
    const ok = await sendLifecycleEmail(USER, MSG);
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe(USER.email);
    expect(m.userId).toBe(USER.id);
    expect(m.stream).toBe("broadcast");
    expect(m.stream).not.toBe("outbound");
    expect(m.listUnsubscribeUrl).toContain("https://int.memex.ai/api/email/unsubscribe?token=");
    expect(m.from).toBe("The Memex AI team <support@memex.ai>");
    expect(m.replyTo).toBe("support@memex.ai");
    // template payload preserved
    expect(m.commsType).toBe("activation.connected_inactive");
  });

  it("skips a suppressed user — no send (ac-12)", async () => {
    tagAc(AC(12));
    isSuppressed.mockResolvedValue(true);
    const ok = await sendLifecycleEmail(USER, MSG);
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("fails CLOSED — a suppression-read error skips the send, never emails on error", async () => {
    tagAc(AC(12));
    isSuppressed.mockRejectedValue(new Error("db down"));
    const ok = await sendLifecycleEmail(USER, MSG);
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("skips a user with no email address", async () => {
    tagAc(AC(11));
    isSuppressed.mockResolvedValue(false);
    const ok = await sendLifecycleEmail({ id: USER.id, email: "" }, MSG);
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
