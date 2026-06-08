// spec-141 dec-3: the "install the Memex MCP CLI" instructions, extracted from
// the standalone `pages/Installation.tsx` into a section so the consolidated
// Integrations page can compose it. Open core. The install bootstrap flow
// (/install/mcp/auth, InstallAuth) is unaffected — this is only the
// human-facing "how to install" copy. Cross-link to MCP tokens is now an
// in-page anchor.
//
// spec-201: the URL derivation moved to utils/mcpUrl.ts and the code-block
// primitives to components/CodeBlock.tsx, both shared with GenesisPromptSection.

import { useState } from 'react';
import { CodeBlock, InlineCode } from './CodeBlock';
import { installBase } from '../utils/mcpUrl';

const SH_COMMAND = `curl -fsSL ${installBase}/install.sh | sh`;
const PS_COMMAND = `irm ${installBase}/install.ps1 | iex`;

// spec-201 dec-4: the canonical MCP endpoint, shared by the claude.ai web and
// Cursor connect steps below. Same derivation as the manual configs.
const MCP_URL = `${installBase}/mcp`;

// Cursor MCP config — remote server over HTTP. url-only is correct for dynamic
// OAuth (spec-31): Cursor runs the sign-in flow on connect (no static token).
const CURSOR_CONFIG = `{
  "mcpServers": {
    "memex": {
      "url": "${MCP_URL}"
    }
  }
}`;

function detectOs(): 'mac' | 'linux' | 'windows' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const p = navigator.platform.toLowerCase();
  const u = navigator.userAgent.toLowerCase();
  if (p.includes('mac') || u.includes('mac os')) return 'mac';
  if (p.includes('win') || u.includes('windows')) return 'windows';
  if (p.includes('linux') || u.includes('linux')) return 'linux';
  return 'unknown';
}

export function CliInstallSection() {
  const os = detectOs();
  const cmd = os === 'windows' ? PS_COMMAND : SH_COMMAND;
  const osLabel = os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : 'your OS';

  const [showFallback, setShowFallback] = useState(false);

  return (
    <section id="install-cli" aria-labelledby="install-cli-heading">
      <h2 id="install-cli-heading" className="text-xl font-semibold mb-2 text-heading">Install Memex MCP</h2>
      <p className="mb-8 text-secondary">
        Connect Memex to Claude Code and Claude Desktop. The installer opens your browser
        once to authorize this device — after that it works without ever expiring. Using
        claude.ai (web) or Cursor instead? See <a href="#other-clients" className="underline hover:text-primary">Other clients</a> below.
      </p>

      <div className="mb-10">
        <h3 className="text-base font-medium mb-3 text-heading">Install ({osLabel})</h3>
        <p className="text-sm mb-3 text-secondary">
          Paste this into your terminal:
        </p>
        <CodeBlock code={cmd} />
        <p className="text-xs mt-3 text-muted">
          What this does: downloads a small Node-based installer, opens this admin in your
          browser to authorize the device, then writes the MCP entry into your Claude
          configs.
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
          claude.ai (web) and Cursor connect to the same endpoint and sign in over OAuth —
          no token to paste. Your MCP URL:
        </p>
        <CodeBlock code={MCP_URL} />

        <div className="mt-6 space-y-6">
          <div>
            <h4 className="text-sm font-medium mb-2 text-heading">claude.ai (web)</h4>
            <ol className="list-decimal list-inside text-sm space-y-1 text-secondary">
              <li>Open <strong>Settings → Connectors</strong>.</li>
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
