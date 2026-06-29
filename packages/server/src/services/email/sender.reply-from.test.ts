import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-428 dec-3 / spec-427 dec-1 — the transport carries a per-message named-human
// From and a monitored Reply-To. recordEmailComm is mocked (covered elsewhere).
vi.mock("../comms-log.js", () => ({ recordEmailComm: vi.fn().mockResolvedValue(null) }));
import { PostmarkEmailSender } from "./sender.js";

const AC_SENDER = "mindset-prod/memex-building-itself/specs/spec-428/acs/ac-8";

beforeEach(() => vi.unstubAllGlobals());

function captureBody(): { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ MessageID: "pm-1" }) });
  vi.stubGlobal("fetch", mock);
  return { mock };
}

describe("PostmarkEmailSender — From / Reply-To", () => {
  it("sends a per-message From override and a Reply-To when provided", async () => {
    tagAc(AC_SENDER);
    const { mock } = captureBody();
    const sender = new PostmarkEmailSender("tok", "Memex.AI <support@memex.ai>");
    await sender.send({
      to: "u@acme.test",
      subject: "Hi",
      text: "body",
      from: "Casey at Memex AI <casey@memex.ai>",
      replyTo: "hello@memex.ai",
    });
    const body = JSON.parse((mock.mock.calls[0]![1] as { body: string }).body);
    expect(body.From).toBe("Casey at Memex AI <casey@memex.ai>");
    expect(body.ReplyTo).toBe("hello@memex.ai");
  });

  it("falls back to the configured From and omits Reply-To when not provided", async () => {
    tagAc(AC_SENDER);
    const { mock } = captureBody();
    const sender = new PostmarkEmailSender("tok", "Memex.AI <support@memex.ai>");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body" });
    const body = JSON.parse((mock.mock.calls[0]![1] as { body: string }).body);
    expect(body.From).toBe("Memex.AI <support@memex.ai>");
    expect(body.ReplyTo).toBeUndefined();
  });
});
