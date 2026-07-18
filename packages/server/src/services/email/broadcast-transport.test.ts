// spec-427 t-3 (Slice B) — the lifecycle/broadcast transport: a per-message
// MessageStream, env token isolation, and the RFC 8058 List-Unsubscribe header.
//   ac-11 — 427 emails go on the Postmark broadcast stream (not `outbound`),
//           selected via a per-message stream field, and carry a List-Unsubscribe
//           header. (Suppression is t-4.)
//   ac-15 — int broadcast uses the Postmark TEST token (no delivery); prod uses
//           the real token + real stream; transactional stream/token unchanged;
//           no second Postmark server.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock("../comms-log.js", () => ({ recordEmailComm: vi.fn().mockResolvedValue(null) }));
import { PostmarkEmailSender, getEmailSender, setEmailSender } from "./sender.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;
const AC480 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-480/acs/ac-${n}`;
// Postmark's well-known sandbox token literal — accepts, returns 200, delivers nothing.
const POSTMARK_TEST_TOKEN = "POSTMARK_API_TEST";

function captureFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ MessageID: "pm-1" }) });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const bodyOf = (mock: ReturnType<typeof vi.fn>) =>
  JSON.parse((mock.mock.calls[0]![1] as { body: string }).body);
const tokenOf = (mock: ReturnType<typeof vi.fn>) =>
  (mock.mock.calls[0]![1] as { headers: Record<string, string> }).headers["X-Postmark-Server-Token"];

beforeEach(() => vi.unstubAllGlobals());

describe("PostmarkEmailSender — broadcast stream + List-Unsubscribe (ac-11)", () => {
  it("defaults MessageStream to `outbound` and uses the transactional token", async () => {
    tagAc(AC(15)); // transactional path unchanged
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "Memex.AI <support@memex.ai>", "broadcast-tok");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body" });
    expect(bodyOf(mock).MessageStream).toBe("outbound");
    expect(tokenOf(mock)).toBe("real-tok");
  });

  it("sends a broadcast-stream message on that stream and honours it verbatim", async () => {
    tagAc(AC(11));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from", "broadcast-tok");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    expect(bodyOf(mock).MessageStream).toBe("broadcast");
  });

  it("attaches an angle-bracketed one-click List-Unsubscribe header pair when a URL is given", async () => {
    tagAc(AC(11));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from", "broadcast-tok");
    await sender.send({
      to: "u@acme.test",
      subject: "Hi",
      text: "body",
      stream: "broadcast",
      listUnsubscribeUrl: "https://int.memex.ai/email/unsubscribe?token=TKN",
    });
    const headers = bodyOf(mock).Headers as { Name: string; Value: string }[];
    const unsub = headers.find((h) => h.Name === "List-Unsubscribe");
    const post = headers.find((h) => h.Name === "List-Unsubscribe-Post");
    // RFC 8058/2369 — bracket-wrapped URL or clients won't honour one-click
    expect(unsub?.Value).toBe("<https://int.memex.ai/email/unsubscribe?token=TKN>");
    expect(post?.Value).toBe("List-Unsubscribe=One-Click");
  });

  it("adds no List-Unsubscribe header to a transactional message", async () => {
    tagAc(AC(11));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from", "broadcast-tok");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body" });
    const headers = (bodyOf(mock).Headers ?? []) as { Name: string }[];
    expect(headers.find((h) => h.Name === "List-Unsubscribe")).toBeUndefined();
  });
});

describe("PostmarkEmailSender — click tracking (spec-480 ac-11)", () => {
  it("sets TrackLinks=HtmlAndText when trackLinks is true (the win-back)", async () => {
    tagAc(AC480(11));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from", "broadcast-tok");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast", trackLinks: true });
    expect(bodyOf(mock).TrackLinks).toBe("HtmlAndText");
  });

  it("omits TrackLinks — and never TrackOpens/pixel — when trackLinks is not set", async () => {
    tagAc(AC480(11));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from", "broadcast-tok");
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    expect(bodyOf(mock).TrackLinks).toBeUndefined();
    expect(bodyOf(mock).TrackOpens).toBeUndefined(); // click tracking only, no open pixel
  });
});

describe("PostmarkEmailSender — env token isolation (ac-15)", () => {
  it("uses the broadcast token for a broadcast-stream send, the shared token for transactional", async () => {
    tagAc(AC(15));
    const sender = new PostmarkEmailSender("real-tok", "from", POSTMARK_TEST_TOKEN);

    const broadcast = captureFetch();
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    expect(tokenOf(broadcast)).toBe(POSTMARK_TEST_TOKEN);

    vi.unstubAllGlobals();
    const transactional = captureFetch();
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body" });
    expect(tokenOf(transactional)).toBe("real-tok");
  });

  it("falls back to the shared token for broadcast when no broadcast token is configured", async () => {
    tagAc(AC(15));
    const mock = captureFetch();
    const sender = new PostmarkEmailSender("real-tok", "from"); // no broadcast token
    await sender.send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    expect(tokenOf(mock)).toBe("real-tok");
  });
});

describe("getEmailSender — fail-safe broadcast token wiring (ac-15)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    setEmailSender(null);
    process.env = { ...saved };
  });

  it("defaults the broadcast token to the Postmark TEST sandbox literal when unset (int-safe)", async () => {
    tagAc(AC(15));
    setEmailSender(null);
    process.env.POSTMARK_SERVER_TOKEN = "real-tok";
    process.env.EMAIL_FROM = "Memex.AI <support@memex.ai>";
    delete process.env.POSTMARK_BROADCAST_TOKEN;
    const mock = captureFetch();
    await getEmailSender().send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    // no explicit broadcast token → sandbox, so a forgotten int deploy never sends real broadcast mail
    expect(tokenOf(mock)).toBe(POSTMARK_TEST_TOKEN);
  });

  it("uses the configured broadcast token when set (prod opts into real delivery)", async () => {
    tagAc(AC(15));
    setEmailSender(null);
    process.env.POSTMARK_SERVER_TOKEN = "real-tok";
    process.env.EMAIL_FROM = "Memex.AI <support@memex.ai>";
    process.env.POSTMARK_BROADCAST_TOKEN = "real-tok";
    const mock = captureFetch();
    await getEmailSender().send({ to: "u@acme.test", subject: "Hi", text: "body", stream: "broadcast" });
    expect(tokenOf(mock)).toBe("real-tok");
  });
});
