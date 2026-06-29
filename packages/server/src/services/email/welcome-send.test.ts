import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-428 t-3 — sendWelcomeEmail behaviour. comms-log is mocked so this is a pure
// unit test (no DB); the real idempotency read is covered by the integration test.
vi.mock("../comms-log.js", () => ({ hasComm: vi.fn().mockResolvedValue(false) }));
import { hasComm } from "../comms-log.js";
import { setEmailSender, type EmailMessage } from "./sender.js";
import { sendWelcomeEmail } from "./welcome-send.js";

const AC_ONCE = "mindset-prod/memex-building-itself/specs/spec-428/acs/ac-2";

let sent: EmailMessage[];
beforeEach(() => {
  sent = [];
  vi.mocked(hasComm).mockResolvedValue(false);
  setEmailSender({
    send: async (m) => {
      sent.push(m);
    },
  });
});
afterEach(() => setEmailSender(null));

describe("sendWelcomeEmail", () => {
  it("sends the welcome with the user's first name, the welcome comms key, and userId", async () => {
    await sendWelcomeEmail({ id: "u1", email: "sam@acme.test", name: "Sam Smith" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("sam@acme.test");
    expect(sent[0]!.commsType).toBe("welcome");
    expect(sent[0]!.userId).toBe("u1");
    expect(sent[0]!.html).toContain("Hi Sam,");
  });

  it("is idempotent — skips when a welcome was already logged (dec-7)", async () => {
    tagAc(AC_ONCE);
    vi.mocked(hasComm).mockResolvedValue(true);
    await sendWelcomeEmail({ id: "u1", email: "sam@acme.test", name: "Sam" });
    expect(sent).toHaveLength(0);
  });

  it("degrades to a nameless greeting when the user has no name", async () => {
    await sendWelcomeEmail({ id: "u2", email: "x@y.test", name: null });
    expect(sent[0]!.html).toContain("Hi there,");
  });

  it("never throws — a send failure is swallowed (advisory, dec-1)", async () => {
    setEmailSender({
      send: async () => {
        throw new Error("postmark down");
      },
    });
    await expect(
      sendWelcomeEmail({ id: "u3", email: "z@y.test", name: "Zoe" }),
    ).resolves.toBeUndefined();
  });
});
