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
import {
  isPillNotificationEnabled,
  setPillNotificationEnabled,
} from '../desktop/mcpPillPrefs';
import { runInstall, type InstallFailureKind } from '../desktop/install';
import { ClaudeConnectorDialog } from './ClaudeConnectorDialog';

const BUTTON_LABEL: Record<ClientStatus['button'], string> = {
  install: 'Install',
  reinstall: 'Reinstall',
  repair: 'Repair',
  connector: 'Install for my org',
};

/**
 * The standing record of a failed in-app install (dec-25, ac-68). Holds the
 * target + name so Retry can re-run the exact same install, plus the structured
 * failure detail the surface explains. The pill stays the standing SUCCESS
 * signal; the failure lives here in the Integrations action surface instead.
 */
interface InstallFailure {
  target: McpTargetKey;
  name: string;
  failure: InstallFailureKind;
  configPath?: string;
  error?: string;
}

/**
 * Map a failure mode to a plain-language cause (ac-68). Each distinguishes WHY
 * the install failed so the user knows whether to re-authenticate or check the
 * config file — never leaks the session token.
 */
function failureCause(name: string, f: InstallFailure): string {
  switch (f.failure) {
    case 'mint':
      return `Couldn't get a token from your current session to connect ${name}. Your sign-in may have expired — reload Memex and try again.`;
    case 'config-write':
      return `Couldn't write ${name}'s config file${
        f.configPath ? ` (${f.configPath})` : ''
      }. The file may be locked, read-only, or in use — close ${name} and retry.`;
    default:
      return `Couldn't connect Memex to ${name}. Retry, and if it keeps failing, copy the details below.`;
  }
}

/**
 * Assemble the copyable diagnostic (ac-68): the target config path, the
 * underlying error, and the app/OS version (userAgent). SECURITY: this is built
 * from non-secret fields only — `runInstall` never puts the session token in the
 * outcome, so the token cannot reach this string.
 */
function diagnosticText(f: InstallFailure): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
  return [
    `Memex MCP install failed`,
    `Client: ${f.name}`,
    `Stage: ${f.failure}`,
    `Config path: ${f.configPath ?? 'n/a'}`,
    `Error: ${f.error ?? 'n/a'}`,
    `App/OS: ${ua}`,
  ].join('\n');
}

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
  // A failed install lives here as a structured record (dec-25, ac-68): a
  // plain-language cause, a Retry that re-runs the exact install, and a
  // copyable diagnostic. `statusError` (a probe failure) stays a plain string.
  const [installFailure, setInstallFailure] = useState<InstallFailure | null>(null);
  const [copied, setCopied] = useState(false);
  // The Claude Desktop connector-instructions dialog (t-56).
  const [connectorOpen, setConnectorOpen] = useState(false);

  const handleInstall = useCallback(
    async (target: McpTargetKey, name: string) => {
      setBusy(target);
      setMessage(null);
      setInstallFailure(null);
      setCopied(false);
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
      } else if (outcome.failure !== 'cancelled') {
        setInstallFailure({
          target,
          name,
          failure: outcome.failure,
          configPath: outcome.configPath,
          error: outcome.error,
        });
      }
    },
    [token, refresh],
  );

  const copyDiagnostic = useCallback(async (f: InstallFailure) => {
    try {
      await navigator.clipboard.writeText(diagnosticText(f));
      setCopied(true);
      // Revert the label so a second copy is discoverable (the first copy
      // otherwise leaves the button reading "Copied" indefinitely).
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard denial must not throw — the user can still read the cause.
      setCopied(false);
    }
  }, []);

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
        current login and write it into one shared <code>~/.claude.json</code> (a <code>.bak</code>{' '}
        is saved first) — no terminal, no copy-pasted token. That one install covers Claude Code{' '}
        <strong>everywhere it runs</strong>: the terminal, your IDE extensions, and the Code tab{' '}
        inside Claude Desktop. Claude Desktop's <strong>Chat</strong> and <strong>Cowork</strong>{' '}
        connect separately through a connector you add inside Claude (it doesn't cover the Code tab —
        Claude Code's install already does). Restart the client afterwards to finish connecting.
      </p>

      {phase === 'loading' && <p className="text-sm text-secondary">Checking MCP status…</p>}
      {statusError && (
        <p className="text-sm text-error mb-4" role="alert">{statusError}</p>
      )}
      {message && (
        <p className="text-sm text-status-success-text mb-4" role="status">{message}</p>
      )}

      {/* dec-25 (ac-68): the install-failure action surface. The pill stays the
          standing SUCCESS signal; a failed ACTION explains itself HERE, with a
          plain-language cause, a Retry, and a copyable (token-free) diagnostic. */}
      {installFailure && (
        <div
          data-testid="mcp-install-error"
          role="alert"
          className="text-sm mb-4 p-3 rounded-md border border-status-error-edge bg-status-error-bg"
        >
          <p className="text-status-error-text mb-2">
            {failureCause(installFailure.name, installFailure)}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleInstall(installFailure.target as McpTargetKey, installFailure.name)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              Retry
            </button>
            <button
              onClick={() => copyDiagnostic(installFailure)}
              className="text-xs px-3 py-1.5 rounded-sm border border-edge text-secondary hover:opacity-90"
            >
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        </div>
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
              // Claude Desktop – Org Connector: open the connector-instructions
              // dialog. No token logic, no in-app file write, and no pill — the
              // app can't add or detect an account-level connector (dec-23/dec-24).
              <button
                onClick={() => setConnectorOpen(true)}
                className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90"
              >
                {BUTTON_LABEL.connector}
              </button>
            ) : (
              // Token clients (Claude Code): the install action PLUS a per-client
              // "MCP status notification" toggle (dec-24, ac-57). Off → this
              // client no longer drives the native pill; the inline status above
              // stays. Lets a user who'll never use this client silence the pill.
              <div className="flex items-center gap-3">
                <label
                  className="flex items-center gap-1.5 text-xs text-secondary cursor-pointer select-none"
                  title="Show this client's MCP status in the desktop app's pill"
                  data-testid={`mcp-notify-${key}`}
                >
                  <input
                    type="checkbox"
                    checked={isPillNotificationEnabled(key)}
                    onChange={(e) => setPillNotificationEnabled(key, e.target.checked)}
                  />
                  MCP status notification
                </label>
                <button
                  onClick={() => handleInstall(key as McpTargetKey, name)}
                  disabled={busy !== null}
                  className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
                >
                  {busy === key ? 'Installing MCP…' : BUTTON_LABEL[status.button]}
                </button>
              </div>
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
