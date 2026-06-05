// spec-141 dec-3: the "install the Memex MCP CLI" instructions, extracted from
// the standalone `pages/Installation.tsx` into a section so the consolidated
// Integrations page can compose it. Open core. The install bootstrap flow
// (/install/mcp/auth, InstallAuth) is unaffected — this is only the
// human-facing "how to install" copy. Cross-link to MCP tokens is now an
// in-page anchor.

import { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? '';
const isDeployed = API_URL.startsWith('http');

// Bootstrap URLs (/install.{sh,ps1}) are served from the same Cloud Run service
// that hosts the API — the canonical host is whatever VITE_API_URL resolves to.
// In dev we point at the local server's bootstrap path.
const installBase = isDeployed
  ? API_URL.replace(/\/api\/?$/, '')
  : 'http://localhost:8080';

const SH_COMMAND = `curl -fsSL ${installBase}/install.sh | sh`;
const PS_COMMAND = `irm ${installBase}/install.ps1 | iex`;

function detectOs(): 'mac' | 'linux' | 'windows' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const p = navigator.platform.toLowerCase();
  const u = navigator.userAgent.toLowerCase();
  if (p.includes('mac') || u.includes('mac os')) return 'mac';
  if (p.includes('win') || u.includes('windows')) return 'windows';
  if (p.includes('linux') || u.includes('linux')) return 'linux';
  return 'unknown';
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="absolute top-2 right-2 px-2 py-1 text-xs font-medium rounded transition-colors bg-btn-secondary hover:bg-btn-secondary-hover text-secondary"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative group">
      <CopyButton text={code} />
      <pre className="border rounded-lg p-4 overflow-x-auto text-sm leading-relaxed bg-surface border-edge">
        <code className="text-primary">{code}</code>
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded text-xs text-primary bg-input">{children}</code>
  );
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
        once to authorize this device — after that it works without ever expiring.
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
