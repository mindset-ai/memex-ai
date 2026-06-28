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
import { fetchJourneyStateApi } from '../api/journey';
import {
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
        if (failedProbes.current >= 2 && phaseRef.current !== 'ready') {
          setPhase('error');
        }
        return;
      }
      failedProbes.current = 0;

      const activeTokens: ActiveToken[] = tokens
        .filter((t) => !t.revokedAt)
        .map((t) => ({ prefix: t.prefix, lastUsedAt: t.lastUsedAt }));
      // User-scoped MCP connection signal — the Claude Desktop CONNECTOR has no
      // local entry to read, so its "connected" derives from this (dec-23).
      const userConnected = journey?.milestones.mcpConnected ?? false;

      const per: DesktopMcpClient[] = MCP_CLIENTS.map(({ key, name, transport }) => ({
        key,
        name,
        transport,
        status:
          transport === 'connector'
            ? deriveConnectorStatus({ connected: userConnected })
            : deriveClientStatus(local[key], { activeTokens }),
      }));
      setClients(per);
      setError(null);
      setPhase('ready');

      // Push the aggregate indicator to the native pill (dec-21). React owns the
      // truth; the shell owns the on-open timing + visibility policy. This is the
      // push that makes the pill app-global (issue-24 #1).
      void setMcpStatusBridge(deriveIndicator(per.map((c) => c.status)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read MCP status');
      setPhase('error');
    }
  }, [inShell, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Real-time: a token minted/revoked anywhere re-derives status (and the mint
  // that an in-app install performs flows back through here to update the pill).
  useUserChangeStream(() => void refresh(), ['mcp_token']);

  return { inShell, phase, clients, error, refresh };
}
