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
    memex: null,
    // spec-300 issue-6b — `memex-ai skill push <dir>`: the local directory to push.
    dir: null,
    yes: false,
    help: false,
    skipBrowser: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "uninstall" || a === "--uninstall") out.command = "uninstall";
    else if (a === "install") out.command = "install";
    // checkout-setup: mint + store the scoped hook key off the one Memex sign-in
    // (spec-371 dec-10). The plugin handles MCP + hooks declaratively; this only
    // provisions the credential — it never plants into settings.json.
    else if (a === "checkout-setup") out.command = "checkout-setup";
    // `skill push <dir>` (spec-300 issue-6b) — upload a local SKILL.md package.
    else if (a === "skill") out.command = "skill";
    else if (a === "push" && out.command === "skill") out.command = "skill-push";
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--api-base") out.apiBase = args[++i];
    else if (a === "--admin-base") out.adminBase = args[++i];
    else if (a === "--label") out.label = args[++i];
    else if (a === "--memex") out.memex = args[++i];
    else if (a === "--no-browser") out.skipBrowser = true;
    // The first bare (non-flag) token after `skill push` is the directory.
    else if (out.command === "skill-push" && out.dir === null && !a.startsWith("-")) {
      out.dir = a;
    }
  }
  return out;
}
