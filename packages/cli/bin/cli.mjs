#!/usr/bin/env node

// Memex MCP installer (v2). Device-flow auth: claim a code from the server, open the
// user's browser to authorize, long-poll for a long-lived mxt_ token, then merge it
// into the Claude Code + Claude Desktop config files.
//
// Zero dependencies — Node 18+ built-ins only. The pure logic lives in ../lib/ so the
// behaviour is unit-testable; this file just wires stdout + browser side-effects.

import { hostname, platform } from "node:os";
import { spawn } from "node:child_process";

import { parseArgs, DEFAULT_API_BASE } from "../lib/argv.js";
import { getConfigTargets } from "../lib/config-paths.js";
import { writeMemexEntry, removeMemexEntry } from "../lib/config-merge.js";
import { startCliAuth, pollForToken } from "../lib/auth-flow.js";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function printHelp() {
  console.log(`  ${BOLD}Usage:${RESET}`);
  console.log(`    memex-ai install         Authorize this device + write Claude configs (default)`);
  console.log(`    memex-ai uninstall       Remove memex from Claude configs`);
  console.log();
  console.log(`  ${BOLD}Options:${RESET}`);
  console.log(`    --label <name>           Device label (default: hostname)`);
  console.log(`    --api-base <url>         Memex server (default: ${DEFAULT_API_BASE})`);
  console.log(`    --admin-base <url>       Memex UI base URL for the auth confirm page (default: derived from --api-base)`);
  console.log(`    --no-browser             Skip auto-opening the browser; print URL only`);
  console.log(`    -h, --help               Show this message`);
  console.log();
}

function openInBrowser(url) {
  const cmd = platform() === "darwin" ? "open" :
              platform() === "win32" ? "start" : "xdg-open";
  try {
    const p = spawn(cmd, [url], { detached: true, stdio: "ignore", shell: platform() === "win32" });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

async function uninstall() {
  const targets = getConfigTargets();
  let removed = false;
  for (const target of Object.values(targets)) {
    const result = await removeMemexEntry(target);
    if (result.removed) {
      console.log(`  ${GREEN}✓${RESET} Removed from ${BOLD}${result.name}${RESET}`);
      removed = true;
    }
  }
  if (!removed) {
    console.log(`  ${DIM}Memex MCP was not configured in any client.${RESET}`);
  }
  console.log(`  ${DIM}Note: this only removes the local config — your token on the server is`);
  console.log(`        still active. Visit /settings/tokens to revoke it.${RESET}`);
  console.log();
}

async function install({ apiBase, adminBase: adminBaseArg, label, skipBrowser }) {
  const deviceLabel = label || hostname() || "Unknown device";

  console.log(`  ${BOLD}Step 1/3${RESET} — claiming device code...`);
  const { reqId, code } = await startCliAuth(apiBase);

  // The device-flow confirm page lives on the same host as the API now (single-host
  // path-routed). Explicit --admin-base wins; otherwise strip /api from apiBase.
  const adminBase = adminBaseArg ?? apiBase.replace("/api", "");
  const authUrl = `${adminBase}/install/mcp/auth?code=${code}`;

  console.log();
  console.log(`  ${BOLD}Step 2/3${RESET} — open this URL in your browser:`);
  console.log();
  console.log(`    ${CYAN}${authUrl}${RESET}`);
  console.log();
  console.log(`    ${DIM}Code: ${BOLD}${code}${RESET}${DIM} (valid for 5 minutes)${RESET}`);
  console.log();

  if (!skipBrowser) {
    if (openInBrowser(authUrl)) {
      console.log(`  ${DIM}(opened in your default browser)${RESET}`);
    } else {
      console.log(`  ${YELLOW}Could not auto-open browser; copy the URL above.${RESET}`);
    }
    console.log();
  }

  console.log(`  ${BOLD}Step 3/3${RESET} — waiting for authorization...`);
  const token = await pollForToken(apiBase, reqId);

  console.log();
  console.log(`  ${GREEN}✓${RESET} Token issued (mxt_…). Writing Claude configs:`);
  console.log();

  const mcpUrl = `${apiBase}/mcp`;
  const targets = getConfigTargets();
  for (const target of Object.values(targets)) {
    const result = await writeMemexEntry(target, mcpUrl, token);
    console.log(`  ${GREEN}✓${RESET} Configured ${BOLD}${result.name}${RESET}`);
    console.log(`    ${DIM}${result.path}${RESET}`);
  }

  console.log();
  console.log(`  ${GREEN}${BOLD}Done!${RESET} Restart Claude to pick up the new MCP server.`);
  console.log(`  ${DIM}Device label: ${deviceLabel}. Manage tokens at ${adminBase}/settings/tokens${RESET}`);
  console.log();
  console.log(`  ${DIM}Tip: for Claude.ai web or Claude Code, you can also use OAuth via the${RESET}`);
  console.log(`  ${DIM}     in-product connector picker. This CLI is best for CI / scripted setups.${RESET}`);
  console.log();
}

async function main() {
  const args = parseArgs(process.argv);
  console.log();
  console.log(`  ${BOLD}Memex AI${RESET} — MCP ${args.command === "uninstall" ? "Uninstaller" : "Installer"}`);
  console.log();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.command === "uninstall") {
    await uninstall();
    return;
  }

  await install(args);
}

main().catch((err) => {
  console.error();
  console.error(`  ${RED}Error:${RESET} ${err.message}`);
  console.error();
  process.exit(1);
});
