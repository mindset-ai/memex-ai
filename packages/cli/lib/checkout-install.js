// lib/checkout-install.js — spec-371 plugin install/uninstall for the Memex CLI.
//
// Plants the spec-checkout hooks into the Claude settings (pointing at the bundled
// plugin scripts) and writes the local checkout config the edit hook reads
// ({ api_base, hook_key }). One explicit step in, one step out, no residue
// (dec-6, ac-8). All fs goes through an injectable `fs` (mirrors config-merge.js)
// so it is unit-testable with no real files. Our hooks are identified by their
// own script names, so uninstall removes exactly ours and never a user's other
// hooks, and settings.json stays a clean, standard shape (no marker fields).

import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rm as fsRm,
} from "node:fs/promises";
import { existsSync as fsExistsSync } from "node:fs";

const DEFAULT_FS = {
  mkdir: fsMkdir,
  readFile: fsReadFile,
  writeFile: fsWriteFile,
  rm: fsRm,
  existsSync: fsExistsSync,
};

const OUR_SCRIPTS = ["marker-write.mjs", "edit-phonehome.mjs"];

// What the hook ever transmits — surfaced to the developer at install time (ac-8).
export const TRANSMITS =
  "changed file paths + the claimed spec ref + git commit/branch; never source code or prompts";

export function buildHookEntries(pluginRoot) {
  const cmd = (script) => `node "${pluginRoot}/hooks/${script}"`;
  return [
    {
      matcher: "mcp__memex__(claim_spec|unclaim_spec|update_doc)",
      hooks: [{ type: "command", command: cmd("marker-write.mjs") }],
    },
    {
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: cmd("edit-phonehome.mjs") }],
    },
  ];
}

async function readJson(filePath, fs) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return {};
  }
}

// A PostToolUse entry is ours iff one of its commands names one of our scripts.
function isOurs(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some(
    (h) => typeof h?.command === "string" && OUR_SCRIPTS.some((s) => h.command.includes(s)),
  );
}

// Install: merge our PostToolUse hooks into the settings JSON (dropping any prior
// copy first → idempotent), and write the checkout config. Preserves the user's
// other hooks. Returns a summary including exactly what the hook will transmit.
export async function installCheckout(opts, fs = DEFAULT_FS) {
  const { settingsPath, settingsDir, configPath, configDir, pluginRoot, apiBase, hookKey } = opts;

  const settings = await readJson(settingsPath, fs);
  if (!settings.hooks) settings.hooks = {};
  const existing = Array.isArray(settings.hooks.PostToolUse) ? settings.hooks.PostToolUse : [];
  settings.hooks.PostToolUse = [
    ...existing.filter((e) => !isOurs(e)),
    ...buildHookEntries(pluginRoot),
  ];
  if (!fs.existsSync(settingsDir)) await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const config = { api_base: apiBase, hook_key: hookKey };
  if (!fs.existsSync(configDir)) await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  return { settingsPath, configPath, transmits: TRANSMITS };
}

// Uninstall: strip our hooks from settings (leaving others intact) and remove the
// checkout config. Idempotent — safe to run when nothing is installed.
export async function uninstallCheckout(opts, fs = DEFAULT_FS) {
  const { settingsPath, configPath } = opts;

  const settings = await readJson(settingsPath, fs);
  let removedHooks = false;
  if (Array.isArray(settings.hooks?.PostToolUse)) {
    const kept = settings.hooks.PostToolUse.filter((e) => !isOurs(e));
    removedHooks = kept.length !== settings.hooks.PostToolUse.length;
    if (kept.length === 0) delete settings.hooks.PostToolUse;
    else settings.hooks.PostToolUse = kept;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  let removedConfig = false;
  try {
    await fs.rm(configPath, { force: true });
    removedConfig = true;
  } catch {
    /* nothing to remove */
  }
  return { removedHooks, removedConfig };
}

// Mint a scoped hook key via the tenant-scoped REST route (membership-gated). The
// installer calls this after its device-flow auth, with the user's bearer token.
// The minted key is least-privilege: it authorises only the record-only phone-home
// (dec-6) — never the user's MCP PAT or OAuth token. Injectable fetch for tests.
export async function mintHookKey(apiBase, namespace, memex, token, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${apiBase}/api/${namespace}/${memex}/hook-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: "memex checkout hook" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to mint hook key (${res.status}): ${body}`);
  }
  const json = await res.json();
  if (!json || typeof json.key !== "string") {
    throw new Error("Mint response missing key");
  }
  return json.key;
}
