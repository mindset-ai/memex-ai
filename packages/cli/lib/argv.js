// Pure argv parser for the memex-ai CLI. No side effects, no console — just in/out so
// the behaviour is trivially testable. Keep the grammar identical to bin/cli.mjs.

export const DEFAULT_API_BASE = "https://memex.ai";

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    command: "install",
    apiBase: DEFAULT_API_BASE,
    adminBase: null,
    label: null,
    yes: false,
    help: false,
    skipBrowser: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "uninstall" || a === "--uninstall") out.command = "uninstall";
    else if (a === "install") out.command = "install";
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--api-base") out.apiBase = args[++i];
    else if (a === "--admin-base") out.adminBase = args[++i];
    else if (a === "--label") out.label = args[++i];
    else if (a === "--no-browser") out.skipBrowser = true;
  }
  return out;
}
