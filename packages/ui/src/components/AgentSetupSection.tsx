// spec-452: the ONE tabbed, per-client setup surface. It supersedes and merges the
// two overlapping surfaces this replaced (spec-201's "Set up with one prompt" genesis
// toggle + spec-430's "Install Memex MCP" CLI section, whose Claude Code install-prompt
// button duplicated — and diverged from — the genesis prompt). A user is exactly one
// kind of client, so instead of stacking every client's instructions in series we show
// a tab per client and reveal only the selected one.
//
// Five tabs (dec-1): Claude Code · Cursor · Copilot (VS Code) · Claude Desktop ·
// Claude.ai (web). The three coding-agent tabs lead with a copy-paste bootstrap prompt
// (the single source is utils/genesisPrompt.ts — this component is pure JSX and never
// inlines prompt prose, per std-15) and offer a collapsible run-it-yourself/manual
// fallback. Claude Desktop and Claude.ai (web) are instruction-only (no coding agent to
// paste into) — genuinely different flows, hence their own tabs.
//
// Static copy only: nothing here runs or verifies the bootstrap; the pasted agent does
// the work and completes the browser sign-in itself. Open core (no `.ee` marker).

import { useState } from 'react';
import { CodeBlock, InlineCode } from './CodeBlock';
import { installBase, mcpUrl } from '../utils/mcpUrl';
import {
  buildClaudeCodePrompt,
  buildCursorPrompt,
  buildCopilotPrompt,
} from '../utils/genesisPrompt';

type ClientId = 'claude-code' | 'cursor' | 'copilot' | 'claude-desktop' | 'claude-web';

const TABS: { id: ClientId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'copilot', label: 'Copilot (VS Code)' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'claude-web', label: 'Claude.ai (web)' },
];

const CLIENT_IDS = new Set<ClientId>(TABS.map((t) => t.id));
const DEFAULT_CLIENT: ClientId = 'claude-code';

// The unified installer command (spec-430): prod is the bare command; any other env
// passes the host explicitly. Same derivation the genesis prompt uses.
const INSTALL_API_BASE_FLAG =
  installBase === 'https://memex.ai' ? '' : ` --api-base ${installBase}`;
const INSTALL_COMMAND = `npx -y memex-ai install${INSTALL_API_BASE_FLAG}`;

// Claude-Code-only hooks plugin (no MCP bundled — the installer above planted it).
const PLUGIN_COMMANDS = `claude plugin marketplace add mindset-ai/memex-ai
claude plugin install memex-checkout@memex`;

// Manual configs — url-only OAuth-on-connect for the IDEs (spec-253); token-bearing
// fallbacks for the two Claude apps. These are config JSON, not prompt prose.
const CURSOR_CONFIG = `{
  "mcpServers": {
    "memex": {
      "url": "${mcpUrl}"
    }
  }
}`;

const VSCODE_CONFIG = `{
  "servers": {
    "memex": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;

const CLAUDE_CODE_MANUAL_CONFIG = `{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}`;

const CLAUDE_DESKTOP_CONFIG = `{
  "mcpServers": {
    "memex": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${mcpUrl}", "--header", "Authorization:Bearer YOUR_TOKEN_HERE"]
    }
  }
}`;

// Deep-link support (dec-1): `?client=<id>` selects a tab on load so the native desktop
// pill and docs links can target one client. Unknown/absent → the Claude Code default.
function initialClient(): ClientId {
  if (typeof window === 'undefined') return DEFAULT_CLIENT;
  const param = new URLSearchParams(window.location.search).get('client');
  return param && CLIENT_IDS.has(param as ClientId) ? (param as ClientId) : DEFAULT_CLIENT;
}

// A small reusable "run it yourself" disclosure for the coding-agent tabs. The prompt
// is the primary path; this is the collapsible fallback.
function ManualDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm underline text-secondary hover:text-primary"
      >
        {open ? 'Hide manual setup' : 'Prefer to set it up by hand? Show manual setup'}
      </button>
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </div>
  );
}

function TokenNote() {
  return (
    <p className="text-xs text-muted">
      Generate a token in the{' '}
      <a href="#mcp-tokens" className="underline hover:text-primary">
        MCP Tokens
      </a>{' '}
      section, then replace <InlineCode>YOUR_TOKEN_HERE</InlineCode>.
    </p>
  );
}

export function AgentSetupSection() {
  const [client, setClient] = useState<ClientId>(initialClient);

  const selectClient = (id: ClientId) => {
    setClient(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('client', id);
      window.history.replaceState(null, '', url);
    }
  };

  return (
    <section id="install-memex" aria-labelledby="install-memex-heading" className="scroll-mt-6">
      <h2 id="install-memex-heading" className="text-xl font-semibold mb-2 text-heading">
        Set up Memex
      </h2>
      <p className="mb-6 text-secondary">
        Connect Memex to the tool you use. Pick your client below — you only need the one
        you actually work in. The installer opens your browser once to authorize, then
        works without expiring.
      </p>

      <div role="tablist" aria-label="Choose your client" className="flex flex-wrap gap-2 mb-6">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={client === id}
            onClick={() => selectClient(id)}
            className={
              client === id
                ? 'px-3 py-1.5 text-sm font-medium rounded-sm transition-colors bg-btn-primary text-white'
                : 'px-3 py-1.5 text-sm font-medium rounded-sm transition-colors bg-btn-secondary hover:bg-btn-secondary-hover text-secondary'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {client === 'claude-code' && <ClaudeCodePanel />}
        {client === 'cursor' && <CursorPanel />}
        {client === 'copilot' && <CopilotPanel />}
        {client === 'claude-desktop' && <ClaudeDesktopPanel />}
        {client === 'claude-web' && <ClaudeWebPanel />}
      </div>

      <p className="text-xs mt-6 text-muted">
        This is just text to copy — Memex doesn't run anything on your machine. Your agent
        completes the browser sign-in itself when it adds the server.
      </p>
    </section>
  );
}

function ClaudeCodePanel() {
  return (
    <div>
      <h3 className="text-base font-medium mb-2 text-heading">Claude Code</h3>
      <p className="text-sm mb-3 text-secondary">
        Paste this into a Claude Code session. The agent runs the whole setup — the MCP
        server, your checkout key, and the spec-checkout plugin — pausing only for the one
        browser sign-in, and writes a durable <InlineCode>CLAUDE.md</InlineCode> note so it
        reaches for Memex every session.
      </p>
      <CodeBlock code={buildClaudeCodePrompt(mcpUrl)} />

      <ManualDisclosure>
        <p className="text-sm text-secondary">
          Prefer to run the commands yourself? One browser sign-in plants the MCP token{' '}
          <strong>and</strong> mints your single per-user checkout key:
        </p>
        <CodeBlock code={INSTALL_COMMAND} />
        <p className="text-sm text-secondary">
          Then add the spec-checkout plugin — the in-flow edit hooks (Claude Code only):
        </p>
        <CodeBlock code={PLUGIN_COMMANDS} />
        <p className="text-xs text-muted">
          Reload the window afterwards — the hooks load at session start. No installer at
          all? Add this to <InlineCode>~/.claude.json</InlineCode>:
        </p>
        <CodeBlock code={CLAUDE_CODE_MANUAL_CONFIG} />
        <TokenNote />
      </ManualDisclosure>
    </div>
  );
}

function CursorPanel() {
  return (
    <div>
      <h3 className="text-base font-medium mb-2 text-heading">Cursor</h3>
      <p className="text-sm mb-3 text-secondary">
        Paste this into a Cursor session. It registers the Memex MCP server and writes a{' '}
        <InlineCode>.cursor/rules/memex.mdc</InlineCode> note so Cursor reaches for Memex
        every session. Cursor signs in over OAuth on connect — no token to paste.
      </p>
      <CodeBlock code={buildCursorPrompt(mcpUrl)} />

      <ManualDisclosure>
        <p className="text-xs text-muted">
          Prefer to edit config directly? Add to <InlineCode>.cursor/mcp.json</InlineCode>{' '}
          (this project) or <InlineCode>~/.cursor/mcp.json</InlineCode> (everywhere), then
          reload Cursor and complete the OAuth sign-in:
        </p>
        <CodeBlock code={CURSOR_CONFIG} />
      </ManualDisclosure>
    </div>
  );
}

function CopilotPanel() {
  return (
    <div>
      <h3 className="text-base font-medium mb-2 text-heading">Copilot (VS Code)</h3>
      <p className="text-sm mb-3 text-secondary">
        For GitHub Copilot in VS Code agent mode. Paste this into a Copilot session — it
        registers the server in <InlineCode>.vscode/mcp.json</InlineCode> and writes a{' '}
        <InlineCode>.github/copilot-instructions.md</InlineCode> note so Copilot reaches for
        Memex every session. Copilot signs in over OAuth on connect — no token to paste.
      </p>
      <CodeBlock code={buildCopilotPrompt(mcpUrl)} />

      <ManualDisclosure>
        <p className="text-xs text-muted">
          Prefer to edit config directly? Add to <InlineCode>.vscode/mcp.json</InlineCode>,
          then run <InlineCode>MCP: List Servers</InlineCode> → <strong>Start</strong> and
          complete the sign-in:
        </p>
        <CodeBlock code={VSCODE_CONFIG} />
        <p className="text-xs text-muted">
          Windsurf and Zed use the same URL in their own MCP config and sign in over OAuth
          the same way — no token required.
        </p>
      </ManualDisclosure>
    </div>
  );
}

function ClaudeDesktopPanel() {
  return (
    <div>
      <h3 className="text-base font-medium mb-2 text-heading">Claude Desktop</h3>
      <p className="text-sm mb-3 text-secondary">
        Claude Desktop is a chat app, not a coding agent, so there's no prompt to paste.
        Install the MCP server with the same unified installer — but <strong>skip the
        plugin</strong> (the spec-checkout hooks run in Claude Code only):
      </p>
      <CodeBlock code={INSTALL_COMMAND} />
      <p className="text-xs mt-3 text-muted">
        Prefer no installer? Add to{' '}
        <InlineCode>~/Library/Application Support/Claude/claude_desktop_config.json</InlineCode>{' '}
        (macOS) or <InlineCode>%APPDATA%\Claude\claude_desktop_config.json</InlineCode>{' '}
        (Windows):
      </p>
      <CodeBlock code={CLAUDE_DESKTOP_CONFIG} />
      <TokenNote />
    </div>
  );
}

function ClaudeWebPanel() {
  return (
    <div>
      <h3 className="text-base font-medium mb-2 text-heading">Claude.ai (web)</h3>
      <p className="text-sm mb-3 text-secondary">
        claude.ai connects over OAuth as a custom connector — there's no token to paste.
        Your MCP URL:
      </p>
      <CodeBlock code={mcpUrl} />
      <ol className="list-decimal list-inside text-sm space-y-1 mt-4 text-secondary">
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
  );
}
