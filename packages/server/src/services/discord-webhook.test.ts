import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { postToDiscord } from "./discord-webhook.js";

// spec-138 t-2 — postToDiscord() payload shape unit tests.
//
// These tests verify the wire-format produced by postToDiscord() without making
// real HTTP calls. fetch is replaced with a vi.fn() spy that captures the body
// and returns a minimal ok response.

const AC_8  = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-8";  // no embeds when specRef omitted
const AC_9  = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-9";  // embeds array present when specRef provided
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-10"; // embed footer text + url
const AC_11 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-11"; // no markdown conversion

const headers = { get: () => null };
const OK_RESPONSE = { ok: true, status: 204, statusText: "No Content", headers } as unknown as Response;

function capturedBody(fetchSpy: ReturnType<typeof vi.fn>): unknown {
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("postToDiscord: payload shape", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(OK_RESPONSE));
  });

  it("without embedFooter — payload has only a `content` field, no `embeds`", async () => {
    tagAc(AC_8);
    const fetchSpy = vi.mocked(fetch);

    await postToDiscord("https://discord.com/api/webhooks/test", "Hello world");

    const body = capturedBody(fetchSpy);
    expect(body).toEqual({ content: "Hello world" });
    expect(body).not.toHaveProperty("embeds");
  });

  it("with embedFooter — payload has both `content` and `embeds` array", async () => {
    tagAc(AC_9);
    const fetchSpy = vi.mocked(fetch);

    await postToDiscord(
      "https://discord.com/api/webhooks/test",
      "Deployment complete",
      { text: "📄 From Spec: Discord Integration", url: "https://memex.ai/mindset-prod/memex-building-itself/specs/spec-138" },
    );

    const body = capturedBody(fetchSpy) as { content: string; embeds: unknown[] };
    expect(body).toHaveProperty("content", "Deployment complete");
    expect(body).toHaveProperty("embeds");
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(body.embeds).toHaveLength(1);
  });

  it("embed description is placed as-is from the footer description field (dec-3)", async () => {
    tagAc(AC_10);
    const fetchSpy = vi.mocked(fetch);

    const footer = {
      description: "**Spec:** [Discord Integration](https://memex.ai/mindset-prod/memex-building-itself/specs/spec-138)",
    };
    await postToDiscord("https://discord.com/api/webhooks/test", "msg", footer);

    const body = capturedBody(fetchSpy) as { embeds: Array<{ description: string }> };
    const embed = body.embeds[0];
    expect(embed.description).toBe(footer.description);
  });

  it("message text is passed as-is — no markdown conversion applied (dec-4)", async () => {
    tagAc(AC_11);
    const fetchSpy = vi.mocked(fetch);

    const markdown = "**bold** *italic* `code` [link](https://example.com) # heading";
    await postToDiscord("https://discord.com/api/webhooks/test", markdown);

    const body = capturedBody(fetchSpy) as { content: string };
    expect(body.content).toBe(markdown);
  });

  it("POSTs to the provided webhook URL with application/json", async () => {
    tagAc(AC_8);
    const fetchSpy = vi.mocked(fetch);

    const url = "https://discord.com/api/webhooks/specific-channel";
    await postToDiscord(url, "test");

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("throws when Discord returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request", headers } as unknown as Response));

    await expect(
      postToDiscord("https://discord.com/api/webhooks/test", "msg"),
    ).rejects.toThrow("Discord webhook POST failed: 400 Bad Request");
  });
});
