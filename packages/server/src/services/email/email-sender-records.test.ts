import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-341 t-1 — the chokepoint wiring (ac-10): a successful Postmark send records
// the email via recordEmailComm, capturing the Postmark MessageID. recordEmailComm
// is mocked here (its own behaviour is covered by comms-log-email.integration).
vi.mock("../comms-log.js", () => ({ recordEmailComm: vi.fn().mockResolvedValue(null) }));
import { recordEmailComm } from "../comms-log.js";
import { PostmarkEmailSender } from "./sender.js";

const AC10 = "mindset-prod/memex-building-itself/specs/spec-341/acs/ac-10";

beforeEach(() => {
  vi.mocked(recordEmailComm).mockClear();
  vi.unstubAllGlobals();
});

describe("PostmarkEmailSender records the comm (spec-341 ac-10)", () => {
  it("ac-10: a successful send records via recordEmailComm with the Postmark MessageID + context", async () => {
    tagAc(AC10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ MessageID: "pm-abc-123" }) }),
    );
    const sender = new PostmarkEmailSender("tok", "Memex <x@memex.ai>");
    await sender.send({
      to: "u@acme.test",
      subject: "Hi",
      text: "body",
      userId: "user-1",
      commsType: "activation",
    });
    expect(recordEmailComm).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "u@acme.test",
        userId: "user-1",
        commsType: "activation",
        subject: "Hi",
        messageId: "pm-abc-123",
      }),
    );
  });

  it("ac-10: a failed send throws and records nothing (recording never masks a send failure)", async () => {
    tagAc(AC10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );
    const sender = new PostmarkEmailSender("tok", "Memex <x@memex.ai>");
    await expect(sender.send({ to: "u@acme.test", subject: "Hi", text: "body" })).rejects.toThrow();
    expect(recordEmailComm).not.toHaveBeenCalled();
  });
});
