import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { postToDiscord } from "./discord-webhook.js";

// spec-138 t-2 — postToDiscord() payload shape unit tests.
//
// These tests verify the wire-format produced by postToDiscord() without making
// real HTTP calls. fetch is replaced with a vi.fn() spy that captures the body
// and returns a minimal ok response.
//
// AC tagging note (issue-1 / issue-2): ac-8, ac-9, and ac-10 are statements
// about the TOOL HANDLER's behaviour ("when specRef is/isn't provided") — they
// are verified at the handler layer in agent/spec-138-discord-handler.integration.test.ts,
// NOT here. postToDiscord takes a pre-built footer arg and knows nothing about
// specRef, so tagging these ACs at this layer was a false-layer claim. This file
// retains only ac-11 (text passed as-is before the POST is a genuine
// postToDiscord-level property); the rest remain as plain regression coverage.

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

  // Restore the real fetch after each test. Without this, the stubbed global
  // leaks into the @memex-ai-ac/vitest setupFile's afterEach, which POSTs AC
  // emissions via fetch — the stub swallows them and the tagged ACs (e.g.
  // ac-11) never reach Memex. This is why those ACs sat untested historically.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without embedFooter — payload has only a `content` field, no `embeds`", async () => {
    const fetchSpy = vi.mocked(fetch);

    await postToDiscord("https://discord.com/api/webhooks/test", "Hello world");

    const body = capturedBody(fetchSpy);
    expect(body).toEqual({ content: "Hello world" });
    expect(body).not.toHaveProperty("embeds");
  });

  it("with embedFooter — payload has both `content` and `embeds` array", async () => {
    const fetchSpy = vi.mocked(fetch);

    await postToDiscord(
      "https://discord.com/api/webhooks/test",
      "Deployment complete",
      { description: "**Spec:** [Discord Integration](https://memex.ai/mindset-prod/memex-building-itself/specs/spec-138)" },
    );

    const body = capturedBody(fetchSpy) as { content: string; embeds: Array<{ description: string }> };
    expect(body).toHaveProperty("content", "Deployment complete");
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].description).toContain("Discord Integration");
  });

  it("embed description is placed as-is from the footer description field (dec-3)", async () => {
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
    const fetchSpy = vi.mocked(fetch);

    const url = "https://discord.com/api/webhooks/specific-channel";
    await postToDiscord(url, "test");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

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
