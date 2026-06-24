import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  installCheckout,
  uninstallCheckout,
  mintHookKey,
  TRANSMITS,
} from "../lib/checkout-install.js";

// spec-371 t-6 — CLI install/uninstall + hook-key minting.
// ac-8 (scope): installs in one explicit step, uninstalls in one with no residue,
// authenticates with a dedicated least-privilege credential (never the MCP auth),
// shows exactly what it transmits, and assumes no VCS layout.
const AC_8 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-8";

// In-memory fs double (mirrors config-merge.test.js).
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
    async rm(p) {
      files.delete(p);
    },
    existsSync(p) {
      return dirs.has(p) || files.has(p);
    },
  };
}

const opts = {
  settingsPath: "/home/u/.claude/settings.json",
  settingsDir: "/home/u/.claude",
  configPath: "/home/u/.memex/checkout.json",
  configDir: "/home/u/.memex",
  pluginRoot: "/home/u/.memex/plugin",
  apiBase: "https://memex.ai",
  hookKey: "mxh_secret",
};

const isOurEntry = (e) =>
  e.hooks.some(
    (h) => h.command.includes("marker-write.mjs") || h.command.includes("edit-phonehome.mjs"),
  );

describe("checkout-install (spec-371 ac-8)", () => {
  it("install plants both hooks + the config, preserving the user's other hooks", async () => {
    tagAc(AC_8);
    const fs = makeFs({
      [opts.settingsPath]: JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    });
    const res = await installCheckout(opts, fs);
    expect(res.transmits).toBe(TRANSMITS);

    const settings = JSON.parse(fs.files.get(opts.settingsPath));
    const matchers = settings.hooks.PostToolUse.map((e) => e.matcher);
    expect(matchers).toContain("Bash"); // user hook survives
    expect(matchers).toContain("mcp__memex__(claim_spec|unclaim_spec|update_doc)");
    expect(matchers).toContain("Edit|Write|MultiEdit");

    expect(JSON.parse(fs.files.get(opts.configPath))).toEqual({
      api_base: "https://memex.ai",
      hook_key: "mxh_secret",
    });
  });

  it("install is idempotent — a second install does not duplicate our hooks", async () => {
    tagAc(AC_8);
    const fs = makeFs();
    await installCheckout(opts, fs);
    await installCheckout(opts, fs);
    const settings = JSON.parse(fs.files.get(opts.settingsPath));
    expect(settings.hooks.PostToolUse.filter(isOurEntry)).toHaveLength(2);
  });

  it("uninstall removes exactly our hooks + the config, leaves other hooks, and is idempotent", async () => {
    tagAc(AC_8);
    const fs = makeFs({
      [opts.settingsPath]: JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    });
    await installCheckout(opts, fs);
    const r1 = await uninstallCheckout(opts, fs);
    expect(r1.removedHooks).toBe(true);
    expect(r1.removedConfig).toBe(true);

    const settings = JSON.parse(fs.files.get(opts.settingsPath));
    expect(settings.hooks.PostToolUse.map((e) => e.matcher)).toEqual(["Bash"]);
    expect(fs.files.has(opts.configPath)).toBe(false);

    const r2 = await uninstallCheckout(opts, fs);
    expect(r2.removedHooks).toBe(false); // clean no-op
  });

  it("mintHookKey POSTs to the tenant-scoped route with a Bearer token and returns the raw key", async () => {
    tagAc(AC_8);
    let captured;
    const fakeFetch = async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ key: "mxh_minted" }) };
    };
    const key = await mintHookKey(
      "https://memex.ai",
      "mindset-prod",
      "memex-building-itself",
      "mxt_pat",
      { fetch: fakeFetch },
    );
    expect(key).toBe("mxh_minted");
    expect(captured.url).toBe(
      "https://memex.ai/api/mindset-prod/memex-building-itself/hook-keys",
    );
    expect(captured.init.headers.Authorization).toBe("Bearer mxt_pat");
  });

  it("mintHookKey throws on a non-ok response (fail loudly, not silently keyless)", async () => {
    tagAc(AC_8);
    const fakeFetch = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
    await expect(
      mintHookKey("https://memex.ai", "ns", "m", "tok", { fetch: fakeFetch }),
    ).rejects.toThrow(/403/);
  });

  it("the shipped plugin manifest is transparent about what it sends, no VCS assumed (ac-8)", () => {
    tagAc(AC_8);
    const manifestPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../plugin/.claude-plugin/plugin.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.description).toMatch(/changed file paths/i);
    expect(manifest.description).toMatch(/never source code or prompts/i);
  });
});
