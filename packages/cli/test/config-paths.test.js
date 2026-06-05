import { describe, it, expect } from "vitest";
import { getConfigTargets } from "../lib/config-paths.js";

function mkDeps(platform, home = "/home/test", env = {}) {
  return {
    homedir: () => home,
    platform: () => platform,
    env,
  };
}

describe("getConfigTargets", () => {
  it("resolves macOS paths under ~/Library/Application Support", () => {
    const targets = getConfigTargets(mkDeps("darwin", "/Users/alice"));
    expect(targets.claudeCode.path).toBe("/Users/alice/.claude.json");
    expect(targets.claudeDesktop.path).toBe(
      "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json"
    );
    expect(targets.claudeDesktop.dir).toBe(
      "/Users/alice/Library/Application Support/Claude"
    );
  });

  it("resolves Linux paths identically to macOS (same layout)", () => {
    const targets = getConfigTargets(mkDeps("linux", "/home/alice"));
    expect(targets.claudeCode.path).toBe("/home/alice/.claude.json");
    expect(targets.claudeDesktop.path).toBe(
      "/home/alice/Library/Application Support/Claude/claude_desktop_config.json"
    );
  });

  it("resolves Windows paths under %APPDATA%/Claude", () => {
    const targets = getConfigTargets(
      mkDeps("win32", "C:\\Users\\alice", { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" })
    );
    expect(targets.claudeCode.path).toBe("C:\\Users\\alice/.claude.json");
    expect(targets.claudeDesktop.path).toContain("Claude");
    expect(targets.claudeDesktop.path).toContain("claude_desktop_config.json");
  });

  it("builds the Claude Code http entry with Authorization header", () => {
    const targets = getConfigTargets(mkDeps("darwin"));
    const entry = targets.claudeCode.buildEntry({
      url: "https://mcp.example.com/mcp",
      token: "mxt_abc",
    });
    expect(entry).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer mxt_abc" },
    });
  });

  it("builds the Claude Desktop mcp-remote entry with Authorization header arg", () => {
    const targets = getConfigTargets(mkDeps("darwin"));
    const entry = targets.claudeDesktop.buildEntry({
      url: "https://mcp.example.com/mcp",
      token: "mxt_abc",
    });
    expect(entry).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header",
        "Authorization:Bearer mxt_abc",
      ],
    });
  });
});
