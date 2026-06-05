import { describe, it, expect } from "vitest";
import { parseUserAgent, parseClientIp } from "./mcp-telemetry.js";

describe("parseUserAgent", () => {
  it("parses claude-code with extras in parens", () => {
    // Real shape we captured during the session-id spike. The extras
    // ("claude-vscode, agent-sdk/0.3.145") are intentionally dropped from
    // the name/version columns — they're available in the raw user_agent
    // column for re-parsing.
    expect(
      parseUserAgent("claude-code/2.1.145 (claude-vscode, agent-sdk/0.3.145)"),
    ).toEqual({ name: "claude-code", version: "2.1.145" });
  });

  it("parses a plain name/version token", () => {
    expect(parseUserAgent("cursor/0.42.3")).toEqual({
      name: "cursor",
      version: "0.42.3",
    });
  });

  it("returns null name + null version for null / empty / undefined input", () => {
    expect(parseUserAgent(null)).toEqual({ name: null, version: null });
    expect(parseUserAgent(undefined)).toEqual({ name: null, version: null });
    expect(parseUserAgent("")).toEqual({ name: null, version: null });
  });

  it("returns name + null version when there's no slash", () => {
    // Less informative but at least we keep the name signal.
    expect(parseUserAgent("Mozilla/5.0")).toEqual({
      name: "Mozilla",
      version: "5.0",
    });
    expect(parseUserAgent("plain-name")).toEqual({
      name: "plain-name",
      version: null,
    });
  });

  it("handles leading slash safely (no empty name)", () => {
    expect(parseUserAgent("/2.0")).toEqual({ name: "/2.0", version: null });
  });
});

describe("parseClientIp", () => {
  it("returns the first IP in an XFF chain", () => {
    // Per the XFF convention, the client IP is the leftmost entry; proxies
    // append themselves on the right.
    expect(parseClientIp("203.0.113.7, 10.0.0.1, 172.16.0.1")).toBe(
      "203.0.113.7",
    );
  });

  it("returns a single IP unchanged", () => {
    expect(parseClientIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("trims whitespace", () => {
    expect(parseClientIp("  203.0.113.7  ,10.0.0.1")).toBe("203.0.113.7");
  });

  it("returns null for null / undefined / empty", () => {
    expect(parseClientIp(null)).toBeNull();
    expect(parseClientIp(undefined)).toBeNull();
    expect(parseClientIp("")).toBeNull();
  });

  it("returns null for an XFF chain that's only commas / whitespace", () => {
    expect(parseClientIp(",,,")).toBeNull();
    expect(parseClientIp("   ,   ")).toBeNull();
  });
});
