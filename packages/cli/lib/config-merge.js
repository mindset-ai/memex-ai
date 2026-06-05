// JSON-merge + filesystem operations for writing the memex entry into Claude configs.
// All fs calls go through `fs` so tests can drop in a tmpdir-backed or in-memory layer
// without monkey-patching node:fs. Returns structured results so callers can print.

import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { existsSync as fsExistsSync } from "node:fs";

const DEFAULT_FS = {
  mkdir: fsMkdir,
  readFile: fsReadFile,
  writeFile: fsWriteFile,
  existsSync: fsExistsSync,
};

// Missing / unreadable / malformed files all normalize to `{}` — install is supposed to
// be idempotent and a corrupt config shouldn't block the user.
export async function readJsonFile(filePath, fs = DEFAULT_FS) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Merges `{ mcpServers: { memex: entry } }` into the JSON at `target.path` without
// clobbering other mcpServers entries. Creates the parent directory if missing.
export async function writeMemexEntry(target, mcpUrl, token, fs = DEFAULT_FS) {
  const config = await readJsonFile(target.path, fs);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.memex = target.buildEntry({ url: mcpUrl, token });

  if (!fs.existsSync(target.dir)) {
    await fs.mkdir(target.dir, { recursive: true });
  }
  await fs.writeFile(target.path, JSON.stringify(config, null, 2) + "\n");
  return { path: target.path, name: target.name, config };
}

// Removes the memex entry if present. Returns whether a removal happened so callers can
// report "was not configured" vs "removed from X".
export async function removeMemexEntry(target, fs = DEFAULT_FS) {
  const config = await readJsonFile(target.path, fs);
  if (!config.mcpServers?.memex) {
    return { removed: false, path: target.path, name: target.name };
  }
  delete config.mcpServers.memex;
  await fs.writeFile(target.path, JSON.stringify(config, null, 2) + "\n");
  return { removed: true, path: target.path, name: target.name };
}
