// spec-304 t-58 (issue-24, dec-19/dec-20/dec-21): the APP-GLOBAL MCP status
// derivation for the desktop shell.
//
// The native nav-bar pill is meant to be ubiquitous (dec-19's whole rationale).
// Originally the derive + `setMcpStatus` push lived inside DesktopMcpSection,
// which only mounts on Settings → Integrations — so the pill stayed empty on
// every other page (issue-24 #1). This hook lifts the probe → derive → push out
// of the page so it runs on EVERY route: mount it once app-globally (see
// <DesktopMcpStatusSync/>) and the pill reflects status regardless of which page
// is open. DesktopMcpSection reuses the SAME hook for its per-client rows.
//
// It joins three truths client-side (dec-20): the local Claude config (the
// read-only mcpStatus bridge), the user's active tokens (listMcpTokensApi, with
// per-token lastUsedAt — ac-52), and the user-scoped mcp.connected signal (used
// for the Claude Desktop connector, dec-23). No-op outside the desktop shell.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { useUserChangeStream } from './useUserChangeStream';
import { listMcpTokensApi } from '../api/mcp';
import {
  clearMcpStatusBridge,
  isDesktopShell,
  mcpStatusBridge,
  setMcpStatusBridge,
} from '../desktop/bridge';
import {
  deriveClientStatus,
  deriveConnectorStatus,
  deriveIndicator,
  MCP_CLIENTS,
  type ActiveToken,
  type ClientStatus,
  type ClientTransport,
  type McpStatusResult,
} from '../desktop/mcpStatus';
import { isPillNotificationEnabled, subscribePillPrefs } from '../desktop/mcpPillPrefs';

export type McpPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface DesktopMcpClient {
  key: keyof McpStatusResult;
  name: string;
  transport: ClientTransport;
  status: ClientStatus;
}

export interface DesktopMcpStatus {
  /** Whether we're running inside the Memex desktop shell (vs a plain browser). */
  inShell: boolean;
  phase: McpPhase;
  clients: DesktopMcpClient[];
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Probe + derive + push the desktop MCP status. Safe to mount more than once
 * (the app-global sync AND the Settings section both call it); each call pushes
 * the same derived indicator, and the push is idempotent.
 */
export function useDesktopMcpStatus(): DesktopMcpStatus {
  const { token } = useAuth();
  const inShell = isDesktopShell();
  const [phase, setPhase] = useState<McpPhase>('idle');
  const [clients, setClients] = useState<DesktopMcpClient[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Debounce: a single failed local probe must not flash an error state (dec-20).
  const failedProbes = useRef(0);
  // Read phase in refresh without making it a dependency — keeps refresh stable
  // so the effect + SSE subscription don't churn (the page-scoped version's
  // `phase` dep caused re-subscription on every status change).
  const phaseRef = useRef<McpPhase>('idle');
  phaseRef.current = phase;
  // Bumped whenever the per-client pill preferences change, so the push effect
  // below re-runs and re-derives what the pill should show (dec-24).
  const [prefsVersion, setPrefsVersion] = useState(0);

  const refresh = useCallback(async () => {
    if (!inShell) return;
    setPhase((p) => (p === 'ready' ? p : 'loading'));
    try {
      const [local, tokens] = await Promise.all([
        mcpStatusBridge(),
        listMcpTokensApi(token),
      ]);
      if (!local) {
        // Probe failed — tolerate transient failures before showing an error.
        failedProbes.current += 1;
        if (failedProbes.current >= 2 && phaseRef.current !== 'ready') {
          setPhase('error');
        }
        return;
      }
      failedProbes.current = 0;

      const activeTokens: ActiveToken[] = tokens
        .filter((t) => !t.revokedAt)
        .map((t) => ({ prefix: t.prefix, lastUsedAt: t.lastUsedAt }));

      const per: DesktopMcpClient[] = MCP_CLIENTS.map(({ key, name, transport }) => ({
        key,
        name,
        transport,
        // Connector clients (Claude Desktop – Org Connector) have no detectable
        // per-client signal, so they get a neutral setup status and never drive
        // the pill (dec-24). Token clients derive from local config ⨝ tokens.
        status:
          transport === 'connector'
            ? deriveConnectorStatus()
            : deriveClientStatus(local[key], { activeTokens }),
      }));
      setClients(per);
      setError(null);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read MCP status');
      setPhase('error');
    }
  }, [inShell, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Push the aggregate indicator to the native pill (dec-21, dec-24) — in its
  // own effect (not inside refresh) so a pill-preference TOGGLE re-pushes
  // without re-probing. Only ENABLED, token-transport clients drive the pill;
  // connector clients never do. When none drive a state, push the explicit HIDE
  // so the pill clears (no "Install MCP" nag for a client the user opted out of).
  useEffect(() => {
    if (!inShell || clients.length === 0) return;
    const pillClients = clients.filter(
      (c) => c.transport === 'token' && isPillNotificationEnabled(c.key),
    );
    if (pillClients.length === 0) {
      void clearMcpStatusBridge();
      return;
    }
    void setMcpStatusBridge(deriveIndicator(pillClients.map((c) => c.status)));
  }, [inShell, clients, prefsVersion]);

  // Re-derive the pill when the per-client notification preference changes
  // (toggled in DesktopMcpSection). The store is shared across hook instances so
  // the app-global sync and the Settings section never disagree.
  useEffect(() => subscribePillPrefs(() => setPrefsVersion((v) => v + 1)), []);

  // Real-time: a token minted/revoked anywhere re-derives status (and the mint
  // that an in-app install performs flows back through here to update the pill).
  useUserChangeStream(() => void refresh(), ['mcp_token']);

  return { inShell, phase, clients, error, refresh };
}
