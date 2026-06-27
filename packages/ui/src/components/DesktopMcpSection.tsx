// spec-304 t-55 (dec-19..22): the in-app "Install Memex MCP" surface for the
// desktop shell. Open core. This is the canonical install/status/manage UI the
// native nav-bar pill and tray item open into (dec-19); it renders ONLY inside
// the Memex desktop shell — a plain browser can't write `~/.claude.json`, so the
// section is hidden there and Settings → Integrations shows the CLI installer
// instead.
//
// React owns intent + credential (mint from the live session) and the status
// derivation; Dart owns the OS-capable actions (config write, native toast) via
// the bridge. The session token is minted in-process and never shown.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useUserChangeStream } from '../hooks/useUserChangeStream';
import { listMcpTokensApi, mintMcpTokenApi } from '../api/mcp';
import { fetchJourneyStateApi } from '../api/journey';
import {
  installMcpBridge,
  isDesktopShell,
  mcpStatusBridge,
  setMcpStatusBridge,
  showNotificationBridge,
  type McpTargetKey,
} from '../desktop/bridge';
import {
  deriveClientStatus,
  deriveIndicator,
  MCP_CLIENTS,
  type ClientStatus,
  type McpStatusResult,
} from '../desktop/mcpStatus';
import { runInstall } from '../desktop/install';

type Phase = 'idle' | 'loading' | 'ready' | 'error';

interface PerClient {
  key: keyof McpStatusResult;
  name: string;
  status: ClientStatus;
}

const BUTTON_LABEL: Record<ClientStatus['button'], string> = {
  install: 'Install',
  reinstall: 'Reinstall',
  repair: 'Repair',
};

export function DesktopMcpSection() {
  const { token } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [clients, setClients] = useState<PerClient[]>([]);
  const [busy, setBusy] = useState<keyof McpStatusResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Debounce: a single failed local probe must not flash an error state (dec-20).
  const failedProbes = useRef(0);

  const inShell = isDesktopShell();

  const refresh = useCallback(async () => {
    if (!inShell) return;
    setPhase((p) => (p === 'ready' ? p : 'loading'));
    try {
      const [local, tokens, journey] = await Promise.all([
        mcpStatusBridge(),
        listMcpTokensApi(token),
        fetchJourneyStateApi().catch(() => null),
      ]);
      if (!local) {
        // Probe failed — tolerate transient failures before showing an error.
        failedProbes.current += 1;
        if (failedProbes.current >= 2 && phase !== 'ready') setPhase('error');
        return;
      }
      failedProbes.current = 0;

      const activePrefixes = new Set(
        tokens.filter((t) => !t.revokedAt).map((t) => t.prefix),
      );
      const connected = journey?.milestones.mcpConnected ?? false;

      const per: PerClient[] = MCP_CLIENTS.map(({ key, name }) => ({
        key,
        name,
        status: deriveClientStatus(local[key], {
          activeTokenPrefixes: activePrefixes,
          connected,
        }),
      }));
      setClients(per);
      setPhase('ready');

      // Push the aggregate indicator to the native pill (dec-21). React owns the
      // truth; the shell owns the on-open timing + visibility policy.
      void setMcpStatusBridge(deriveIndicator(per.map((c) => c.status)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read MCP status');
      setPhase('error');
    }
  }, [inShell, token, phase]);

  useEffect(() => {
    void refresh();
    // Re-derive when the user mints/revokes a token elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inShell, token]);

  // Real-time: a token minted/revoked on another device re-derives status.
  useUserChangeStream(() => void refresh(), ['mcp_token']);

  const handleAction = useCallback(
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
    <section id="desktop-mcp" aria-labelledby="desktop-mcp-heading">
      <h2 id="desktop-mcp-heading" className="text-xl font-semibold mb-2 text-heading">
        Install Memex MCP on this device
      </h2>
      <p className="text-sm mb-6 text-secondary">
        Connect Claude to your Memexes from this app — no terminal, no copy-pasted token.
        We mint a token from your current login and write it into the client's config
        (a <code>.bak</code> is saved first). Restart the client afterwards to finish connecting.
      </p>

      {phase === 'loading' && <p className="text-sm text-secondary">Checking MCP status…</p>}
      {error && <p className="text-sm text-error mb-4" role="alert">{error}</p>}
      {message && (
        <p className="text-sm text-status-success-text mb-4" role="status">{message}</p>
      )}

      <div className="border rounded-lg overflow-hidden bg-overlay border-edge">
        {clients.map(({ key, name, status }) => (
          <div
            key={key}
            data-testid={`mcp-client-${key}`}
            className="flex items-center justify-between px-4 py-3 border-b last:border-0 border-edge-subtle"
          >
            <div>
              <div className="text-sm text-primary">{name}</div>
              <div
                className="text-xs text-secondary"
                data-testid={`mcp-status-${key}`}
              >
                {status.label}
              </div>
            </div>
            <button
              onClick={() => handleAction(key as McpTargetKey, name)}
              disabled={busy !== null}
              className="text-xs px-3 py-1.5 rounded-sm bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {busy === key ? 'Installing MCP…' : BUTTON_LABEL[status.button]}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
