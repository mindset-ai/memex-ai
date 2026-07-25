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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// issue-32 (ac-63): the Ready→Connected handshake is a SILENT, user-less server
// write (mcp-tokens.bumpLastUsed), so no SSE event flips the pill. While the
// pill shows "MCP Ready", re-probe on this backoff (ms) — then STOP (never poll
// forever). A return-to-foreground restarts the schedule from the top.
const REPROBE_BACKOFF_MS = [10_000, 15_000, 30_000, 60_000, 120_000, 240_000, 360_000];

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

// The tokens GET must be BOUNDED: under a saturated per-origin connection pool
// (e.g. SSE streams churning against the dev proxy) the browser can queue the
// request indefinitely, and an unbounded await here leaves the install surface
// on "Checking MCP status…" forever. Each attempt is aborted after the timeout
// (freeing its connection slot); only abort/network failures retry, an HTTP
// error surfaces immediately.
export const TOKENS_FETCH_TIMEOUT_MS = 5_000;
export const TOKENS_FETCH_ATTEMPTS = 3;

function isRetryableFetchError(err: unknown): boolean {
  return (err instanceof Error && err.name === 'AbortError') || err instanceof TypeError;
}

async function listTokensBounded(
  token: string | null,
): Promise<Awaited<ReturnType<typeof listMcpTokensApi>>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKENS_FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TOKENS_FETCH_TIMEOUT_MS);
    try {
      return await listMcpTokensApi(token, { signal: controller.signal });
    } catch (err) {
      if (!isRetryableFetchError(err)) throw err;
      lastError = err;
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not read MCP tokens');
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
  // The last indicator pushed to the native pill, so a redundant re-derive (a
  // background SSE event fires `refresh`, minting a NEW `clients` array on
  // nearly every navigation) doesn't re-push an identical state — re-pushing
  // makes the pill re-reveal/pop by itself (issue-27, ac-58). '__none__' marks
  // the explicit hide so it, too, is pushed only once.
  const lastPushRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!inShell) return;
    setPhase((p) => (p === 'ready' ? p : 'loading'));
    try {
      const [local, tokens] = await Promise.all([
        mcpStatusBridge(),
        listTokensBounded(token),
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
      if (lastPushRef.current !== '__none__') {
        lastPushRef.current = '__none__';
        void clearMcpStatusBridge();
      }
      return;
    }
    const indicator = deriveIndicator(pillClients.map((c) => c.status));
    // De-dupe (issue-27, ac-58): only push when the derived indicator actually
    // changed. A re-derive that lands on the same state must NOT re-push, or the
    // native pill re-reveals on every navigation.
    const key = `${indicator.kind}|${indicator.label}|${indicator.visibility}`;
    if (lastPushRef.current === key) return;
    lastPushRef.current = key;
    void setMcpStatusBridge(indicator);
  }, [inShell, clients, prefsVersion]);

  // Re-derive the pill when the per-client notification preference changes
  // (toggled in DesktopMcpSection). The store is shared across hook instances so
  // the app-global sync and the Settings section never disagree.
  useEffect(() => subscribePillPrefs(() => setPrefsVersion((v) => v + 1)), []);

  // Whether the pill is currently in the "ready" (installed, awaiting first
  // handshake) state — the only state the re-probe below needs to chase.
  const awaitingHandshake = useMemo(() => {
    if (!inShell || clients.length === 0) return false;
    const pillClients = clients.filter(
      (c) => c.transport === 'token' && isPillNotificationEnabled(c.key),
    );
    if (pillClients.length === 0) return false;
    return deriveIndicator(pillClients.map((c) => c.status)).kind === 'ready';
  }, [inShell, clients, prefsVersion]);

  // Backoff re-probe while Ready (issue-32, ac-63). Each step re-runs refresh();
  // once the handshake lands the state leaves 'ready', this effect tears down,
  // and polling stops. After the final step we stop entirely — no infinite
  // poll. Returning to the foreground (visibilitychange → visible) restarts the
  // schedule from the top and probes immediately, so it self-heals after the
  // hard stop and catches a handshake that happened while we were away.
  // `visibilitychange` (not focus) is deliberate: focus churns on every webview
  // navigation, but visibilityState only flips on a genuine hide/show.
  useEffect(() => {
    if (!awaitingHandshake || typeof document === 'undefined') return;
    let step = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNext = () => {
      if (step >= REPROBE_BACKOFF_MS.length) return; // hard stop
      timer = setTimeout(() => {
        void refresh();
        step += 1;
        scheduleNext();
      }, REPROBE_BACKOFF_MS[step]);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      step = 0;
      void refresh();
      scheduleNext();
    };
    scheduleNext();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [awaitingHandshake, refresh]);

  // Real-time: a token minted/revoked anywhere re-derives status (and the mint
  // that an in-app install performs flows back through here to update the pill).
  useUserChangeStream(() => void refresh(), ['mcp_token']);

  return { inShell, phase, clients, error, refresh };
}
