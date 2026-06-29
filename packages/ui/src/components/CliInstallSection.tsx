// spec-141 dec-3: the "install the Memex MCP CLI" instructions, extracted from
// the standalone `pages/Installation.tsx` into a section so the consolidated
// Integrations page can compose it. Open core. The install bootstrap flow
// (/install/mcp/auth, InstallAuth) is unaffected — this is only the
// human-facing "how to install" copy. Cross-link to MCP tokens is now an
// in-page anchor.
//
// spec-201: the URL derivation moved to utils/mcpUrl.ts and the code-block
// primitives to components/CodeBlock.tsx, both shared with GenesisPromptSection.
//
// spec-430 dec-2/dec-4: the canonical Claude Code install is the unified
// `npx -y memex-ai install` — ONE browser sign-in plants the Memex MCP token AND
// mints the single per-user checkout key (no second sign-in, no per-memex keys,
// nothing pasted by hand). Claude Code then adds the HOOKS-ONLY spec-checkout
// plugin via `claude plugin …`. That plugin is CLAUDE-CODE-ONLY — it does not run
// in Cursor or any other agent, so the plugin steps appear in the Claude Code path
// ONLY. Cursor / VS Code / web stay MCP-only over OAuth (the "Other clients" block).

import { useState } from 'react';
import { CodeBlock, InlineCode } from './CodeBlock';
import { installBase } from '../utils/mcpUrl';

// The unified installer (spec-430). Same `--api-base` derivation as the genesis
// prompt: prod is the bare command; any other env passes the host explicitly.
const INSTALL_API_BASE_FLAG = installBase === 'https://memex.ai' ? '' : ` --api-base ${installBase}`;
const INSTALL_COMMAND = `npx -y memex-ai install${INSTALL_API_BASE_FLAG}`;

// Claude Code only — the hooks-only spec-checkout plugin (no MCP bundled; the
// installer above already planted the MCP). Does NOT work in Cursor / other agents.
const PLUGIN_COMMANDS = `claude plugin marketplace add mindset-ai/memex-ai
claude plugin install memex-checkout@memex`;

// spec-430 dec-4: the agent-guided install is the PRINCIPAL Claude Code path. The
// user pastes THIS one prompt into a Claude Code session and the agent runs every
// step itself — pausing only for the single browser sign-in. Step 1 reuses
// INSTALL_COMMAND so its `--api-base` stays correct per environment. The manual
// commands remain below as the run-it-yourself fallback.
const INSTALL_PROMPT = `Set up Memex in this session. Run each step yourself, explain it in one line, and pause for me when a browser sign-in opens:

1. \`${INSTALL_COMMAND}\`. One sign-in that writes the Memex MCP server into my Claude config and mints my checkout key.
2. \`claude plugin marketplace add mindset-ai/memex-ai\`
3. \`claude plugin install memex-checkout@memex\`

Then tell me to reload the window so the hooks load. If a step errors, show me the error and what to do, and never ask me to paste a key by hand.`;

// spec-201 dec-4: the canonical MCP endpoint, shared by the claude.ai web and
// Cursor connect steps below. Same derivation as the manual configs.
const MCP_URL = `${installBase}/mcp`;

// Cursor MCP config — remote server over HTTP. url-only is correct for dynamic
// OAuth (spec-31 / spec-253): Cursor runs the sign-in flow on connect (no static
// token). Cursor's OAuth callback is a private-use scheme (cursor://…), which the
// DCR endpoint accepts per spec-253.
const CURSOR_CONFIG = `{
  "mcpServers": {
    "memex": {
      "url": "${MCP_URL}"
    }
  }
}`;

// VS Code MCP config — `.vscode/mcp.json` uses `servers` (not `mcpServers`) with
// an explicit `type`. url-only = OAuth on connect (spec-253). VS Code may use a
// loopback (127.0.0.1), an https relay, or a vscode:// callback; all are accepted.
const VSCODE_CONFIG = `{
  "servers": {
    "memex": {
      "type": "http",
      "url": "${MCP_URL}"
    }
  }
}`;

export function CliInstallSection() {
  const [showFallback, setShowFallback] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyInstallPrompt = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  return (
    <section id="install-cli" aria-labelledby="install-cli-heading">
      <h2 id="install-cli-heading" className="text-xl font-semibold mb-2 text-heading">Install Memex MCP</h2>
      <p className="mb-8 text-secondary">
        Connect Memex to Claude Code and Claude Desktop. The installer opens your browser
        once to authorize this device — after that it works without ever expiring. Using
        claude.ai (web) or a native IDE like Cursor or VS Code instead? See <a href="#other-clients" className="underline hover:text-primary">Other clients</a> below.
      </p>

      {/* spec-430: the canonical Claude Code path. ONE sign-in plants the MCP token AND
          mints the per-user checkout key; the hooks-only plugin is Claude-Code-only. */}
      <div className="mb-10">
        <h3 className="text-base font-medium mb-3 text-heading">Claude Code</h3>

        {/* spec-430 dec-4: the PRINCIPAL path — let Claude Code drive the install. */}
        <p className="text-sm mb-3 text-secondary">
          The easiest way is to let Claude Code install everything for you. Copy this prompt,
          paste it into a Claude Code session, and the agent runs the whole setup (the MCP
          server, your checkout key, and the spec-checkout plugin), pausing only for the one
          browser sign-in.
        </p>
        <button
          type="button"
          onClick={copyInstallPrompt}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium bg-btn-primary text-white hover:opacity-90 transition-opacity"
        >
          {copied ? '✓ Copied, now paste it into Claude Code' : 'Copy install prompt for Claude Code'}
        </button>

        {/* Fallback: run the commands yourself. */}
        <p className="text-sm mb-3 mt-8 text-secondary">
          Prefer to run the commands yourself? One browser sign-in plants the Memex MCP token{' '}
          <strong>and</strong> mints your single per-user checkout key. No second sign-in,
          no per-memex keys, nothing pasted by hand:
        </p>
        <CodeBlock code={INSTALL_COMMAND} />
        <p className="text-sm mb-3 mt-6 text-secondary">
          Then add the spec-checkout plugin — the in-flow edit hooks. This plugin is{' '}
          <strong>Claude Code only</strong> (it no longer bundles an MCP; the install above
          already planted it):
        </p>
        <CodeBlock code={PLUGIN_COMMANDS} />
        <p className="text-xs mt-3 text-muted">
          Reload the window afterwards — the hooks load at session start. What the installer
          does: opens this admin in your browser to authorize the device once, then writes
          the MCP entry into your Claude config and stores your checkout key.
        </p>
        <p className="text-xs mt-3 text-muted">
          <strong>Claude Desktop</strong> uses the same <InlineCode>npx -y memex-ai install</InlineCode>{' '}
          for the MCP, but skip the plugin steps — the spec-checkout plugin runs in Claude Code only.
        </p>
      </div>

      <div className="mb-10">
        <h3 className="text-base font-medium mb-3 text-heading">Manage tokens</h3>
        <p className="text-sm text-secondary">
          Each install creates a long-lived token tied to this device. You can list and
          revoke tokens in the{' '}
          <a href="#mcp-tokens" className="underline hover:text-primary">
            MCP Tokens
          </a>{' '}
          section above.
        </p>
      </div>

      {/* spec-201 dec-4: claude.ai web + Cursor. Both complete OAuth on connect,
          so there's no token to paste — they just need the MCP URL. */}
      <div id="other-clients" className="mb-10">
        <h3 className="text-base font-medium mb-3 text-heading">Other clients</h3>
        <p className="text-sm mb-3 text-secondary">
          claude.ai (web) and native IDEs — Cursor, VS Code, Windsurf, Zed — connect to the
          same endpoint and sign in over OAuth, so there's no token to paste. Add the server
          with the URL below, then complete the sign-in your client prompts for. Your MCP URL:
        </p>
        <CodeBlock code={MCP_URL} />

        <div className="mt-6 space-y-6">
          <div>
            <h4 className="text-sm font-medium mb-2 text-heading">claude.ai (web)</h4>
            <ol className="list-decimal list-inside text-sm space-y-1 text-secondary">
              <li>
                Open <strong>Customize → Connectors</strong> (
                <a
                  href="https://claude.ai/customize/connectors?modal=add-custom-connector"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-primary"
                >
                  jump straight there
                </a>
                ).
              </li>
              <li>Click <strong>Add custom connector</strong>.</li>
              <li>Name it <InlineCode>Memex</InlineCode> and paste the MCP URL above.</li>
              <li>Save, then complete the sign-in in the popup.</li>
            </ol>
          </div>
          <div>
            <h4 className="text-sm font-medium mb-2 text-heading">Cursor</h4>
            <p className="text-xs mb-2 text-secondary">
              Add to <InlineCode>.cursor/mcp.json</InlineCode> (this project) or{' '}
              <InlineCode>~/.cursor/mcp.json</InlineCode> (everywhere), then reload Cursor and
              complete the OAuth sign-in:
            </p>
            <CodeBlock code={CURSOR_CONFIG} />
          </div>
          <div>
            <h4 className="text-sm font-medium mb-2 text-heading">VS Code</h4>
            <p className="text-xs mb-2 text-secondary">
              Add to <InlineCode>.vscode/mcp.json</InlineCode>, then run{' '}
              <InlineCode>MCP: List Servers</InlineCode> → <strong>Start</strong> and complete the
              sign-in. VS Code completes OAuth automatically over whichever callback it picks
              (a loopback address, its <InlineCode>vscode.dev</InlineCode> relay, or a{' '}
              <InlineCode>vscode://</InlineCode> handler) — all are accepted:
            </p>
            <CodeBlock code={VSCODE_CONFIG} />
            <p className="text-xs mt-2 text-muted">
              Windsurf and Zed use the same URL in their own MCP config and sign in over OAuth
              the same way — no token required.
            </p>
          </div>
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowFallback(!showFallback)}
          className="text-sm underline text-secondary hover:text-primary"
        >
          {showFallback ? 'Hide' : 'Show'} manual configuration (no installer)
        </button>

        {showFallback && (
          <div className="mt-6 space-y-6">
            <p className="text-sm text-secondary">
              Generate a token from the{' '}
              <a href="#mcp-tokens" className="underline">MCP Tokens</a> section,
              then paste this into your Claude config — replacing
              <InlineCode>YOUR_TOKEN_HERE</InlineCode>:
            </p>
            <div>
              <h4 className="text-sm font-medium mb-2 text-heading">Claude Code</h4>
              <p className="text-xs mb-2 text-secondary">
                Add to <InlineCode>~/.claude.json</InlineCode>:
              </p>
              <CodeBlock
                code={`{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "${installBase}/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}`}
              />
            </div>
            <div>
              <h4 className="text-sm font-medium mb-2 text-heading">Claude Desktop</h4>
              <p className="text-xs mb-2 text-secondary">
                Add to{' '}
                <InlineCode>~/Library/Application Support/Claude/claude_desktop_config.json</InlineCode>{' '}
                (macOS) or <InlineCode>%APPDATA%\Claude\claude_desktop_config.json</InlineCode>{' '}
                (Windows):
              </p>
              <CodeBlock
                code={`{
  "mcpServers": {
    "memex": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${installBase}/mcp", "--header", "Authorization:Bearer YOUR_TOKEN_HERE"]
    }
  }
}`}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
