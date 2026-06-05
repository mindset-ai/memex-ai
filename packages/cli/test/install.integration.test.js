import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigTargets } from "../lib/config-paths.js";
import {
  writeMemexEntry,
  removeMemexEntry,
} from "../lib/config-merge.js";

// End-to-end filesystem round-trip of the install + uninstall flow against a real tmpdir.
// Catches integration issues between getConfigTargets + writeMemexEntry that pure in-memory
// unit tests can mask (path joining, mkdir -p, JSON round-tripping on disk).

const scratch = [];

async function makeTmpHome() {
  const home = await mkdtemp(join(tmpdir(), "memex-cli-"));
  scratch.push(home);
  return home;
}

afterEach(async () => {
  while (scratch.length) {
    const path = scratch.pop();
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
});

describe("install → read → uninstall round-trip", () => {
  it("writes both Claude Code + Claude Desktop configs (macOS layout)", async () => {
    const home = await makeTmpHome();
    const targets = getConfigTargets({
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });

    await writeMemexEntry(targets.claudeCode, "https://mcp.test/mcp", "mxt_a");
    await writeMemexEntry(targets.claudeDesktop, "https://mcp.test/mcp", "mxt_a");

    const codeConfig = JSON.parse(
      await readFile(targets.claudeCode.path, "utf-8")
    );
    expect(codeConfig.mcpServers.memex).toEqual({
      type: "http",
      url: "https://mcp.test/mcp",
      headers: { Authorization: "Bearer mxt_a" },
    });

    const desktopConfig = JSON.parse(
      await readFile(targets.claudeDesktop.path, "utf-8")
    );
    expect(desktopConfig.mcpServers.memex.command).toBe("npx");
    expect(desktopConfig.mcpServers.memex.args).toContain("mcp-remote");
  });

  it("uninstall removes the entry but leaves the file + siblings", async () => {
    const home = await makeTmpHome();
    const targets = getConfigTargets({
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });

    // Install, then add a sibling entry by hand to confirm uninstall leaves it intact.
    await writeMemexEntry(targets.claudeCode, "https://mcp.test/mcp", "mxt_a");

    const { writeFile: fsWrite } = await import("node:fs/promises");
    const existing = JSON.parse(
      await readFile(targets.claudeCode.path, "utf-8")
    );
    existing.mcpServers.other = { command: "keep", args: [] };
    await fsWrite(targets.claudeCode.path, JSON.stringify(existing, null, 2));

    const result = await removeMemexEntry(targets.claudeCode);
    expect(result.removed).toBe(true);

    const after = JSON.parse(
      await readFile(targets.claudeCode.path, "utf-8")
    );
    expect(after.mcpServers.memex).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: "keep", args: [] });
  });

  it("re-installing overwrites the memex entry (token rotation)", async () => {
    const home = await makeTmpHome();
    const targets = getConfigTargets({
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });

    await writeMemexEntry(targets.claudeCode, "https://mcp.test/mcp", "mxt_old");
    await writeMemexEntry(targets.claudeCode, "https://mcp.test/mcp", "mxt_new");

    const config = JSON.parse(
      await readFile(targets.claudeCode.path, "utf-8")
    );
    expect(config.mcpServers.memex.headers.Authorization).toBe(
      "Bearer mxt_new"
    );
  });
});
