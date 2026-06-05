import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackClient } from "./client.js";

// ──────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────

const findFirst = vi.fn();
const dbUpdateSet = vi.fn();
const dbUpdateWhere = vi.fn();
const mutateFn = vi.fn();

vi.mock("../../../db/connection.js", () => ({
  db: {
    query: { userSlackTokens: { findFirst } },
    update: () => ({ set: dbUpdateSet }),
  },
}));

vi.mock("./crypto.js", () => ({
  decryptToken: vi.fn(async () => "xoxp-fake-decrypted-token"),
}));

vi.mock("../../mutate.js", () => ({
  mutate: (...args: unknown[]) => mutateFn(...args),
}));

// Slack WebClient mock — exposes a controllable chat.postMessage.
const chatPostMessage = vi.fn();
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: chatPostMessage };
  },
}));

// Import AFTER mocks are set up so module-load picks up the doubles.
const { getSlackClientForUser, wrapWebClient, SlackClientError } = await import("./client.js");
const { WebClient } = await import("@slack/web-api");

beforeEach(() => {
  findFirst.mockReset();
  dbUpdateSet.mockReset();
  dbUpdateWhere.mockReset();
  dbUpdateSet.mockReturnValue({ where: dbUpdateWhere });
  mutateFn.mockReset();
  mutateFn.mockImplementation(async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn());
  chatPostMessage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const FAKE_ORG_ID = "00000000-0000-0000-0000-000000000002";

function makeClient(): SlackClient {
  return wrapWebClient(new WebClient(), FAKE_USER_ID, FAKE_ORG_ID);
}

function slackPlatformError(code: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(`slack: ${code}`) as Error & {
    code: string;
    data: { ok: false; error: string; [k: string]: unknown };
  };
  err.code = "slack_webapi_platform_error";
  err.data = { ok: false, error: code, ...extra };
  return err;
}

// ──────────────────────────────────────────────────────────────────────────
// getSlackClientForUser — token lookup + revoked-row guard
// ──────────────────────────────────────────────────────────────────────────

describe("getSlackClientForUser", () => {
  it("throws not_connected when no row exists", async () => {
    findFirst.mockResolvedValueOnce(undefined);
    await expect(getSlackClientForUser(FAKE_USER_ID, FAKE_ORG_ID)).rejects.toMatchObject({
      name: "SlackClientError",
      code: "not_connected",
    });
  });

  it("throws not_connected when row has revokedAt set", async () => {
    findFirst.mockResolvedValueOnce({
      userId: FAKE_USER_ID,
      ciphertext: new Uint8Array(),
      iv: new Uint8Array(),
      wrappedDek: new Uint8Array(),
      revokedAt: new Date(),
    });
    await expect(getSlackClientForUser(FAKE_USER_ID, FAKE_ORG_ID)).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("returns a SlackClient when an active row exists", async () => {
    findFirst.mockResolvedValueOnce({
      userId: FAKE_USER_ID,
      ciphertext: new Uint8Array([0x01]),
      iv: new Uint8Array(),
      wrappedDek: new Uint8Array(),
      revokedAt: null,
    });
    const client = await getSlackClientForUser(FAKE_USER_ID, FAKE_ORG_ID);
    expect(typeof client.postMessage).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// wrapWebClient — happy path
// ──────────────────────────────────────────────────────────────────────────

describe("postMessage — happy path", () => {
  it("returns ts + channel from a successful chat.postMessage", async () => {
    chatPostMessage.mockResolvedValueOnce({
      ok: true,
      ts: "1700000000.000100",
      channel: "C0123ABCDE",
    });
    const client = makeClient();
    const result = await client.postMessage({
      channel: "C0123ABCDE",
      text: "hello",
    });
    expect(result).toEqual({ ts: "1700000000.000100", channel: "C0123ABCDE" });
    expect(chatPostMessage).toHaveBeenCalledWith({
      channel: "C0123ABCDE",
      text: "hello",
      thread_ts: undefined,
    });
  });

  it("passes thread_ts through", async () => {
    chatPostMessage.mockResolvedValueOnce({ ok: true, ts: "1.0", channel: "C1" });
    await makeClient().postMessage({
      channel: "C1",
      text: "reply",
      thread_ts: "1699999999.000000",
    });
    expect(chatPostMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "reply",
      thread_ts: "1699999999.000000",
    });
  });

  it("throws transient when response.ok is false without an SDK throw", async () => {
    chatPostMessage.mockResolvedValueOnce({ ok: false, error: "unknown_thing" });
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "transient" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Error mapping per doc-23 §4
// ──────────────────────────────────────────────────────────────────────────

describe("postMessage — error mapping", () => {
  it("maps token_revoked → reconnect_required + marks the row revoked", async () => {
    chatPostMessage.mockRejectedValueOnce(slackPlatformError("token_revoked"));
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    // markRevoked is fire-and-forget; the mock captures the call synchronously.
    expect(mutateFn).toHaveBeenCalledTimes(1);
    const [, key] = mutateFn.mock.calls[0];
    expect(key).toMatchObject({
      memexId: "",
      userId: FAKE_USER_ID,
      entity: "user_slack_token",
      action: "updated",
    });
  });

  it("maps not_authed → reconnect_required + marks revoked", async () => {
    chatPostMessage.mockRejectedValueOnce(slackPlatformError("not_authed"));
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    expect(mutateFn).toHaveBeenCalledTimes(1);
  });

  it("maps channel_not_found → channel_not_found WITHOUT marking revoked", async () => {
    chatPostMessage.mockRejectedValueOnce(slackPlatformError("channel_not_found"));
    await expect(
      makeClient().postMessage({ channel: "Cbad", text: "x" }),
    ).rejects.toMatchObject({ code: "channel_not_found" });
    expect(mutateFn).not.toHaveBeenCalled();
  });

  it("maps not_in_channel → not_in_channel WITHOUT marking revoked", async () => {
    chatPostMessage.mockRejectedValueOnce(slackPlatformError("not_in_channel"));
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "not_in_channel" });
    expect(mutateFn).not.toHaveBeenCalled();
  });

  it("maps msg_too_long → invalid_arguments", async () => {
    chatPostMessage.mockRejectedValueOnce(slackPlatformError("msg_too_long"));
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x".repeat(50_000) }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("maps network / unknown errors → transient", async () => {
    chatPostMessage.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "transient" });
    expect(mutateFn).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Rate-limit retry
// ──────────────────────────────────────────────────────────────────────────

describe("postMessage — rate-limit retry", () => {
  it("retries once after Retry-After on ratelimited and returns on success", async () => {
    const rateLimited = slackPlatformError("ratelimited");
    (rateLimited as unknown as { retryAfter: number }).retryAfter = 0; // 0s = effectively immediate
    chatPostMessage.mockRejectedValueOnce(rateLimited);
    chatPostMessage.mockResolvedValueOnce({ ok: true, ts: "2.0", channel: "C1" });

    const result = await makeClient().postMessage({ channel: "C1", text: "x" });
    expect(result.ts).toBe("2.0");
    expect(chatPostMessage).toHaveBeenCalledTimes(2);
  });

  it("throws rate_limited after a second consecutive rate-limit failure", async () => {
    const rateLimited = slackPlatformError("ratelimited");
    (rateLimited as unknown as { retryAfter: number }).retryAfter = 0;
    chatPostMessage.mockRejectedValueOnce(rateLimited);
    chatPostMessage.mockRejectedValueOnce(rateLimited);

    await expect(
      makeClient().postMessage({ channel: "C1", text: "x" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(chatPostMessage).toHaveBeenCalledTimes(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Class shape
// ──────────────────────────────────────────────────────────────────────────

describe("SlackClientError shape", () => {
  it("carries code and cause", () => {
    const cause = new Error("underlying");
    const err = new SlackClientError("not_connected", "msg", cause);
    expect(err.code).toBe("not_connected");
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("SlackClientError");
    expect(err instanceof Error).toBe(true);
  });
});
