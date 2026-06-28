// spec-304 t-55/t-56/t-58 (dec-19..23): the in-app "Install Memex MCP" surface
// for the desktop shell. Open core. This is the canonical install/status/manage
// UI the native nav-bar pill and tray item open into (dec-19); it renders ONLY
// inside the Memex desktop shell — a plain browser can't write `~/.claude.json`,
// so the section is hidden there and Settings → Integrations shows the CLI
// installer instead.
//
// Two transports per dec-23:
//  - Claude Code (token): mint from the live session → installMcp bridge writes
//    the HTTP entry. The session token never leaves the webview.
//  - Claude Desktop (connector): a single "Install for my org" button opens a
//    connector-instructions dialog (the app cannot write an account-level
//    connector — it's guidance, not a file write). The npx mcp-remote path is
//    GONE from the UI (t-56).
//
// The status derivation + native pill push are app-global (useDesktopMcpStatus,
// issue-24 #1); this section reuses the same hook for its per-client rows and to
// refresh after an install.

import { useCallback, useState } from 'react';
import { useAuth } from './AuthContext';
import { mintMcpTokenApi } from '../api/mcp';
import { useDesktopMcpStatus } from '../hooks/useDesktopMcpStatus';
import {
  desktopServerBase,
  installMcpBridge,
  showNotificationBridge,
  type McpTargetKey,
} from '../desktop/bridge';
import type { ClientStatus, McpStatusResult } from '../desktop/mcpStatus';
import { runInstall } from '../desktop/install';
import { ClaudeConnectorDialog } from './ClaudeConnectorDialog';

const BUTTON_LABEL: Record<ClientStatus['button'], string> = {
  install: 'Install',
  reinstall: 'Reinstall',
  repair: 'Repair',
  connector: 'Install for my org',
};

/** The env-derived MCP connector URL the Claude Desktop dialog hands the user. */
function connectorUrl(): string {
  const base = desktopServerBase();
  return base ? `${base}/mcp` : '/mcp';
}

export function DesktopMcpSection() {
  const { token } = useAuth();
  const { inShell, phase, clients, error: statusError, refresh } = useDesktopMcpStatus();
  const [busy, setBusy] = useState<keyof McpStatusResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Claude Desktop connector-instructions dialog (t-56).
  const [connectorOpen, setConnectorOpen] = useState(false);

  const handleInstall = useCallback(
    async (target: McpTargetKey, name: string) => {
      setBusy(target);
      setMessage(null);
      setError(null);
      const outcome = await runInstall(target, name, {
        mint: (label) => mintMcpTokenApi(label, token),
        install: (opts) =>
          installMcpBridge({ token: opts.token, target: opts.target, force: opts.force }),
        notify: (opts) => showNotificationBridge(opts),
        confirmOverwrite: (clientName, path) =>
          window.confirm(
            `${clientName}'s config at ${path} has comments or custom formatting. ` +
              `Back it up (.bak) and overwrite?`,
          ),
      });
      setBusy(null);
      if (outcome.ok) {
        setMessage(`Memex MCP installed for ${name}. Restart ${name} to finish connecting.`);
        await refresh();
      } else if (outcome.reason !== 'cancelled') {
        setError(outcome.reason);
      }
    },
    [token, refresh],
  );

  // The whole surface is desktop-shell-only: a browser can't write the config.
  if (!inShell) return null;

  return (
    // scroll-mt keeps the heading off the very top edge when deep-linked (issue-25).
    <section id="desktop-mcp" aria-labelledby="desktop-mcp-heading" className="scroll-mt-6">
      <h2 id="desktop-mcp-heading" className="text-xl font-semibold mb-2 text-heading">
        Install Memex MCP on this device
      </h2>
      <p className="text-sm mb-6 text-secondary">
        Connect Claude to your Memexes from this app. For Claude Code we mint a token from your
        current login and write it into the client's config (a <code>.bak</code> is saved first) —
        no terminal, no copy-pasted token. Claude Desktop connects through a connector you add
        inside Claude. Restart the client afterwards to finish connecting.
      </p>

      {phase === 'loading' && <p className="text-sm text-secondary">Checking MCP status…</p>}
      {(error ?? statusError) && (
        <p className="text-sm text-error mb-4" role="alert">{error ?? statusError}</p>
      )}
      {message && (
        <p className="text-sm text-status-success-text mb-4" role="status">{message}</p>
      )}

      <div className="border rounded-lg overflow-hidden bg-overlay border-edge">
        {clients.map(({ key, name, transport, status }) => (
          <div
            key={key}
            data-testid={`mcp-client-${key}`}
            className="flex items-center justify-between px-4 py-3 border-b last:border-0 border-edge-subtle"
          >
            <div>
              <div className="text-sm text-primary">{name}</div>
              <div className="text-xs text-secondary" data-testid={`mcp-status-${key}`}>
                {status.label}
              </div>
            </div>
            {transport === 'connector' ? (
              // Claude Desktop: open the connector-instructions dialog. No token
              // logic, no in-app file write — the app can't add a connector (dec-23).
              <button
                onClick={() => setConnectorOpen(true)}
                className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90"
              >
                {BUTTON_LABEL.connector}
              </button>
            ) : (
              <button
                onClick={() => handleInstall(key as McpTargetKey, name)}
                disabled={busy !== null}
                className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {busy === key ? 'Installing MCP…' : BUTTON_LABEL[status.button]}
              </button>
            )}
          </div>
        ))}
      </div>

      {connectorOpen && (
        <ClaudeConnectorDialog
          connectorUrl={connectorUrl()}
          onClose={() => setConnectorOpen(false)}
        />
      )}
    </section>
  );
}
