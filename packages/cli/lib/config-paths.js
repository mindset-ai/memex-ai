// Resolves the on-disk paths + mcpServers entry shape for each supported Claude client.
// `deps` injects `homedir`, `platform`, and `env` so tests can drive each OS without
// spawning a new process. Prod callers use the module-level defaults.

import { homedir as osHomedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

export function getConfigTargets(deps = {}) {
  const homedir = deps.homedir ?? osHomedir;
  const platform = deps.platform ?? osPlatform;
  const env = deps.env ?? process.env;

  const home = homedir();
  const isWindows = platform() === "win32";

  return {
    claudeCode: {
      name: "Claude Code",
      path: join(home, ".claude.json"),
      dir: home,
      buildEntry: ({ url, token }) => ({
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
      }),
    },
    claudeDesktop: {
      name: "Claude Desktop",
      path: isWindows
        ? join(env.APPDATA || "", "Claude", "claude_desktop_config.json")
        : join(
            home,
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json"
          ),
      dir: isWindows
        ? join(env.APPDATA || "", "Claude")
        : join(home, "Library", "Application Support", "Claude"),
      buildEntry: ({ url, token }) => ({
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          url,
          "--header",
          `Authorization:Bearer ${token}`,
        ],
      }),
    },
  };
}
