import { describe, it, expect } from "vitest";
import {
  readJsonFile,
  writeMemexEntry,
  removeMemexEntry,
} from "../lib/config-merge.js";

// In-memory fs double. Matches the exact surface writeMemexEntry / readJsonFile touch
// (readFile, writeFile, mkdir, existsSync) so tests need no tmpdir for unit coverage.
function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    async readFile(p) {
      if (!files.has(p)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    async mkdir(p) {
      dirs.add(p);
    },
    existsSync(p) {
      return dirs.has(p);
    },
  };
}

const httpTarget = {
  name: "Claude Code",
  path: "/home/alice/.claude.json",
  dir: "/home/alice",
  buildEntry: ({ url, token }) => ({
    type: "http",
    url,
    headers: { Authorization: `Bearer ${token}` },
  }),
};

describe("readJsonFile", () => {
  it("returns the parsed JSON when the file exists", async () => {
    const fs = makeFs({ "/a.json": JSON.stringify({ foo: 1 }) });
    await expect(readJsonFile("/a.json", fs)).resolves.toEqual({ foo: 1 });
  });

  it("returns {} when the file is missing", async () => {
    const fs = makeFs();
    await expect(readJsonFile("/missing.json", fs)).resolves.toEqual({});
  });

  it("returns {} when the file is malformed JSON (never throws)", async () => {
    const fs = makeFs({ "/corrupt.json": "not json at all" });
    await expect(readJsonFile("/corrupt.json", fs)).resolves.toEqual({});
  });
});

describe("writeMemexEntry", () => {
  it("creates the config file when it doesn't exist", async () => {
    const fs = makeFs();
    fs.dirs.add("/home/alice");
    await writeMemexEntry(
      httpTarget,
      "https://mcp.example.com/mcp",
      "mxt_abc",
      fs
    );
    const written = JSON.parse(fs.files.get("/home/alice/.claude.json"));
    expect(written.mcpServers.memex).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer mxt_abc" },
    });
  });

  it("preserves other mcpServers entries on re-install", async () => {
    const existing = {
      mcpServers: {
        unrelated: { command: "other", args: ["x"] },
        memex: { type: "http", url: "https://old", headers: {} },
      },
      anotherTopLevelKey: true,
    };
    const fs = makeFs({ "/home/alice/.claude.json": JSON.stringify(existing) });
    fs.dirs.add("/home/alice");
    await writeMemexEntry(
      httpTarget,
      "https://mcp.example.com/mcp",
      "mxt_new",
      fs
    );
    const written = JSON.parse(fs.files.get("/home/alice/.claude.json"));
    expect(written.mcpServers.unrelated).toEqual({
      command: "other",
      args: ["x"],
    });
    expect(written.mcpServers.memex.headers.Authorization).toBe(
      "Bearer mxt_new"
    );
    // Non-mcpServers top-level keys must survive — users sometimes store other Claude
    // settings in the same file and a loss there would be a nasty regression.
    expect(written.anotherTopLevelKey).toBe(true);
  });

  it("creates the parent directory when missing", async () => {
    const fs = makeFs();
    await writeMemexEntry(
      httpTarget,
      "https://mcp.example.com/mcp",
      "mxt_abc",
      fs
    );
    expect(fs.dirs.has("/home/alice")).toBe(true);
  });

  it("emits trailing newline (prettier/editor-friendly)", async () => {
    const fs = makeFs();
    fs.dirs.add("/home/alice");
    await writeMemexEntry(
      httpTarget,
      "https://mcp.example.com/mcp",
      "mxt_abc",
      fs
    );
    expect(fs.files.get("/home/alice/.claude.json").endsWith("\n")).toBe(true);
  });
});

describe("removeMemexEntry", () => {
  it("returns removed=false when memex is not configured", async () => {
    const fs = makeFs({
      "/home/alice/.claude.json": JSON.stringify({ mcpServers: {} }),
    });
    const result = await removeMemexEntry(httpTarget, fs);
    expect(result.removed).toBe(false);
  });

  it("removes only the memex entry, leaving siblings intact", async () => {
    const existing = {
      mcpServers: {
        memex: { type: "http", url: "x" },
        other: { command: "keep", args: [] },
      },
    };
    const fs = makeFs({ "/home/alice/.claude.json": JSON.stringify(existing) });
    const result = await removeMemexEntry(httpTarget, fs);
    expect(result.removed).toBe(true);
    const written = JSON.parse(fs.files.get("/home/alice/.claude.json"));
    expect(written.mcpServers.memex).toBeUndefined();
    expect(written.mcpServers.other).toEqual({ command: "keep", args: [] });
  });

  it("returns removed=false when the file doesn't exist (no writes)", async () => {
    const fs = makeFs();
    const result = await removeMemexEntry(httpTarget, fs);
    expect(result.removed).toBe(false);
    expect(fs.files.size).toBe(0);
  });
});
