import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// spec-371 t-5 / t-6 — the plugin IS the installer: one Claude Code plugin that
// bundles the Memex MCP server + the checkout hooks, distributed from a committed
// marketplace (dec-9), NOT by hand-planting into ~/.claude/settings.json.
const AC_15 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-15"; // single Claude Code plugin; no per-vendor adapter
const AC_17 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-17"; // marketplace install; settings-planting retired
const AC_8 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-8"; // install transparency / no residue
const AC_6_430 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-6"; // exactly one Memex MCP toolset (plugin is hooks-only)

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../plugin");
const repoRoot = resolve(here, "../../..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("plugin bundle: hooks-only — the CLI plants the MCP (spec-430 dec-2/dec-4)", () => {
  it("the plugin manifest declares NO MCP server — it is hooks-only (spec-430 ac-6)", () => {
    tagAc(AC_6_430);
    // spec-430 dec-2/dec-4 supersedes spec-371's MCP-bundling plugin: a single
    // device-flow sign-in plants the mxt_ MCP via `npx memex-ai install`, so the
    // plugin must NOT also declare an MCP — otherwise the two coexist as duplicate
    // toolsets AND the plugin's OAuth MCP re-introduces a second sign-in.
    const manifest = readJson(resolve(pluginRoot, ".claude-plugin/plugin.json"));
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("the plugin still declares both checkout hooks (marker-write + edit-phonehome)", () => {
    tagAc(AC_15);
    const hooks = readJson(resolve(pluginRoot, "hooks/hooks.json"));
    const cmds = (hooks.hooks?.PostToolUse ?? []).flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds.some((c) => c.includes("marker-write.mjs"))).toBe(true);
    expect(cmds.some((c) => c.includes("edit-phonehome.mjs"))).toBe(true);
  });

  it("the marker-write matcher fires on the plugin-namespaced MCP tool, not just the bare name (regression: v0.1.0 plugin install)", () => {
    tagAc(AC_15);
    const hooks = readJson(resolve(pluginRoot, "hooks/hooks.json"));
    // The PostToolUse entry that runs marker-write.mjs is the one guarding Memex MCP calls.
    const entry = (hooks.hooks?.PostToolUse ?? []).find((e) =>
      e.hooks.some((h) => h.command.includes("marker-write.mjs")),
    );
    expect(entry).toBeTruthy();
    // Anchored is the strict reading (the original `.*` suffix implies start-anchoring);
    // if it passes anchored it passes a looser substring match too.
    const re = new RegExp(`^${entry.matcher}$`);
    // Direct install exposes `mcp__memex__<tool>`; bundled-as-plugin exposes
    // `mcp__plugin_<plugin>_memex__<tool>`. The matcher MUST catch BOTH, or the hook
    // never fires on the plugin's own bundled MCP (the shipped v0.1.0 bug).
    expect(re.test("mcp__memex__claim_spec")).toBe(true);
    expect(re.test("mcp__plugin_memex-checkout_memex__claim_spec")).toBe(true);
  });

  it("no committed token risk — the manifest carries no mcpServers block at all", () => {
    tagAc(AC_6_430);
    // With the MCP planted by the CLI (not bundled), there is no committed MCP entry
    // that could ever carry a per-user bearer token.
    const manifest = readJson(resolve(pluginRoot, ".claude-plugin/plugin.json"));
    expect("mcpServers" in manifest).toBe(false);
  });
});

describe("marketplace distribution; settings.json planting retired (spec-371 ac-17)", () => {
  it("a committed marketplace.json lists the plugin with an in-repo source", () => {
    tagAc(AC_17);
    const mkt = readJson(resolve(repoRoot, ".claude-plugin/marketplace.json"));
    expect(typeof mkt.name).toBe("string");
    expect(mkt.owner?.name).toBeTruthy();
    const entry = (mkt.plugins ?? []).find((p) => p.name === "memex-checkout");
    expect(entry).toBeTruthy();
    expect(entry.source).toBe("./packages/cli/plugin"); // ./-relative from repo root
  });

  it("the marketplace source path resolves to the real plugin manifest", () => {
    tagAc(AC_17);
    const mkt = readJson(resolve(repoRoot, ".claude-plugin/marketplace.json"));
    const entry = mkt.plugins.find((p) => p.name === "memex-checkout");
    const manifestPath = resolve(repoRoot, entry.source, ".claude-plugin/plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    expect(readJson(manifestPath).name).toBe("memex-checkout");
  });

  it("the build-1 settings.json hook-planting installer is retired", () => {
    tagAc(AC_17);
    expect(existsSync(resolve(here, "../lib/checkout-install.js"))).toBe(false);
  });
});

describe("install transparency + no residue (spec-371 ac-8)", () => {
  it("the manifest states exactly what the hook transmits", () => {
    tagAc(AC_8);
    const manifest = readJson(resolve(pluginRoot, ".claude-plugin/plugin.json"));
    expect(manifest.description).toMatch(/changed file paths/i);
    expect(manifest.description).toMatch(/never source code or prompts/i);
  });

  it("no settings.json residue path exists — the planting installer is gone", () => {
    tagAc(AC_8);
    // Claude Code enables/disables the plugin natively; we never hand-edit
    // ~/.claude/settings.json, so uninstall leaves nothing to clean.
    expect(existsSync(resolve(here, "../lib/checkout-install.js"))).toBe(false);
  });
});
