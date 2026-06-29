#!/usr/bin/env node

// Memex MCP installer (v2). Device-flow auth: claim a code from the server, open the
// user's browser to authorize, long-poll for a long-lived mxt_ token, then merge it
// into the Claude Code + Claude Desktop config files.
//
// Zero dependencies — Node 18+ built-ins only. The pure logic lives in ../lib/ so the
// behaviour is unit-testable; this file just wires stdout + browser side-effects.

import { platform } from "node:os";
import { spawn } from "node:child_process";

import { parseArgs, DEFAULT_API_BASE } from "../lib/argv.js";
import { getConfigTargets } from "../lib/config-paths.js";
import { writeMemexEntry, removeMemexEntry } from "../lib/config-merge.js";
import { ensureHookKey, unifiedInstall } from "../lib/checkout-bootstrap.js";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function printHelp() {
  console.log(`  ${BOLD}Usage:${RESET}`);
  console.log(`    memex-ai install         One sign-in → MCP token + checkout key (default)`);
  console.log(`    memex-ai uninstall       Remove memex from Claude configs`);
  console.log(`    memex-ai checkout-setup  Mint JUST the checkout key (one sign-in; no --memex)`);
  console.log();
  console.log(`  ${DIM}Tip: run \`install\` through Claude Code (paste the “Set up your coding agent”`);
  console.log(`       prompt) and it also adds the plugin + reloads for you.${RESET}`);
  console.log();
  console.log(`  ${BOLD}Options:${RESET}`);
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

// Unified install (spec-430 dec-2/dec-3): ONE device-flow sign-in mints BOTH the MCP
// token (planted into the Claude configs) AND the single user-scoped checkout key —
// no second sign-in, no per-memex anything. This command owns CREDENTIALS only; the
// plugin (hooks) is installed by `claude plugin …`, which Claude Code runs for you
// when you paste the "Set up your coding agent" prompt (dec-4).
async function install({ apiBase, adminBase: adminBaseArg, skipBrowser }) {
  const adminBase = adminBaseArg ?? apiBase.replace("/api", "");
  const mcpUrl = `${apiBase}/mcp`;
  const targets = getConfigTargets();

  console.log(`  ${BOLD}Step 1${RESET} — one sign-in mints your MCP token + checkout key...`);

  const result = await unifiedInstall({
    apiBase,
    deps: {
      openBrowser: (url) => {
        console.log();
        console.log(`  ${BOLD}Open this URL to authorize:${RESET}`);
        console.log(`    ${CYAN}${url}${RESET}`);
        console.log();
        if (!skipBrowser && openInBrowser(url)) {
          console.log(`  ${DIM}(opened in your default browser)${RESET}`);
        } else if (!skipBrowser) {
          console.log(`  ${YELLOW}Could not auto-open browser; copy the URL above.${RESET}`);
        }
        console.log(`  ${DIM}waiting for authorization...${RESET}`);
      },
      plantMcp: async (token) => {
        console.log();
        for (const target of Object.values(targets)) {
          const r = await writeMemexEntry(target, mcpUrl, token);
          console.log(`  ${GREEN}✓${RESET} MCP configured for ${BOLD}${r.name}${RESET} ${DIM}${r.path}${RESET}`);
        }
      },
    },
  });

  console.log();
  console.log(
    result.hook.provisioned
      ? `  ${GREEN}✓${RESET} Checkout key minted + stored ${DIM}(~/.memex/checkout.json)${RESET}`
      : `  ${GREEN}✓${RESET} Checkout key already present ${DIM}(no re-mint, no sign-in)${RESET}`,
  );
  console.log();
  console.log(`  ${BOLD}Step 2${RESET} — install the checkout plugin (the hooks):`);
  console.log(`    ${CYAN}claude plugin marketplace add mindset-ai/memex-ai${RESET}`);
  console.log(`    ${CYAN}claude plugin install memex-checkout@memex${RESET}`);
  console.log();
  console.log(`  ${BOLD}Step 3${RESET} — reload the window ${DIM}(hooks load at session start).${RESET}`);
  console.log();
  console.log(`  ${DIM}Easiest path: run this through Claude Code — paste the “Set up your coding`);
  console.log(`       agent” prompt from ${adminBase} and it runs these steps for you.${RESET}`);
  console.log();
}

// checkout-setup: provision JUST the checkout key (when you already have the MCP and
// only need the hook credential). One sign-in mints the single USER key (spec-430
// dec-1/dec-3) — no --memex, never pasted, no per-memex map. An existing key
// short-circuits with no sign-in. Most users don't need this: `install` does it.
async function checkoutSetup({ apiBase, skipBrowser }) {
  console.log(`  ${BOLD}Step 1/2${RESET} — sign in once to mint your checkout key...`);
  const res = await ensureHookKey({
    apiBase,
    deps: {
      // Always surface the URL; auto-open unless --no-browser.
      openBrowser: (url) => {
        console.log();
        console.log(`  ${BOLD}Step 2/2${RESET} — open this URL in your browser to authorize:`);
        console.log();
        console.log(`    ${CYAN}${url}${RESET}`);
        console.log();
        if (!skipBrowser && openInBrowser(url)) {
          console.log(`  ${DIM}(opened in your default browser)${RESET}`);
        } else if (!skipBrowser) {
          console.log(`  ${YELLOW}Could not auto-open browser; copy the URL above.${RESET}`);
        }
        console.log();
        console.log(`  ${DIM}waiting for authorization...${RESET}`);
      },
    },
  });

  console.log();
  console.log(
    res.provisioned
      ? `  ${GREEN}✓${RESET} Checkout key minted + stored ${DIM}(~/.memex/checkout.json)${RESET}`
      : `  ${GREEN}✓${RESET} Already set up — a checkout key is present ${DIM}(no sign-in needed)${RESET}`,
  );
  console.log(
    `  ${DIM}One user key works for EVERY memex you belong to. While checked out (claim_spec),`,
  );
  console.log(`  ${DIM}the edit hook reports edits to the claimed spec's memex.${RESET}`);
  console.log();
}

async function main() {
  const args = parseArgs(process.argv);
  const label =
    args.command === "uninstall"
      ? "Uninstaller"
      : args.command === "checkout-setup"
        ? "Checkout Setup"
        : "Installer";
  console.log();
  console.log(`  ${BOLD}Memex AI${RESET} — MCP ${label}`);
  console.log();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.command === "uninstall") {
    await uninstall();
    return;
  }

  if (args.command === "checkout-setup") {
    await checkoutSetup(args);
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
