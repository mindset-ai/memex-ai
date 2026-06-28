// spec-304 t-55 (dec-20, dec-21 → ac-48, ac-49): the PURE status derivation for
// the in-app MCP install surface. The desktop shell's `mcpStatus` bridge reports
// each Claude client's LOCAL config (installed / urlMatches / tokenPrefix); the
// server reports the user's ACTIVE tokens (by non-secret prefix) and the MCP
// connection signal (the same `mcp.connected` milestone the onboarding journey
// reads). This module joins those three truths client-side — no I/O, no React —
// so the classification is unit-testable in isolation.

/** One client's local-config truth, as returned by the Dart `mcpStatus` bridge. */
export interface McpTargetStatus {
  installed: boolean;
  urlMatches: boolean;
  /** Non-secret 12-char (`mxt_`+8) prefix of the entry's token, or null. */
  tokenPrefix: string | null;
}

/** Both clients, keyed as the bridge returns them. */
export interface McpStatusResult {
  claudeCode: McpTargetStatus;
  claudeDesktop: McpTargetStatus;
}

export type ClientStatusKind =
  | 'not_installed'
  | 'ready' // installed + authorized, no handshake yet
  | 'connected' // installed + authorized + a real MCP handshake observed
  | 'repair' // installed but the token is revoked / unknown
  | 'reinstall'; // installed but pointing at a different server

export type ClientButton = 'install' | 'reinstall' | 'repair';

export interface ClientStatus {
  kind: ClientStatusKind;
  /** The per-client label shown in Settings → Integrations (s-17 table). */
  label: string;
  button: ClientButton;
}

/**
 * Classify ONE client by joining its local config with the user's active token
 * prefixes and the connection signal. A never-installed client is never an error
 * (dec-20). Precedence once installed: wrong-server → revoked/unknown-token →
 * connected → ready.
 */
export function deriveClientStatus(
  local: McpTargetStatus | undefined,
  opts: { activeTokenPrefixes: ReadonlySet<string>; connected: boolean },
): ClientStatus {
  if (!local || !local.installed) {
    return { kind: 'not_installed', label: 'Not installed', button: 'install' };
  }
  if (!local.urlMatches) {
    return { kind: 'reinstall', label: 'Points elsewhere', button: 'reinstall' };
  }
  const authorized =
    local.tokenPrefix != null && opts.activeTokenPrefixes.has(local.tokenPrefix);
  if (!authorized) {
    return { kind: 'repair', label: 'Token invalid', button: 'repair' };
  }
  if (opts.connected) {
    return { kind: 'connected', label: 'MCP connected', button: 'reinstall' };
  }
  return { kind: 'ready', label: 'MCP ready', button: 'reinstall' };
}

export type IndicatorKind = 'connected' | 'ready' | 'repair' | 'install';

export type IndicatorVisibility =
  | 'transient' // healthy: show the true state briefly on window open, then hide
  | 'persistent' // an actionable error: stay until resolved
  | 'snoozable'; // an opportunity (never installed): dismissible prompt

/**
 * The single app-global indicator the native pill renders (dec-21). It is a
 * quiet EXCEPTION surface, not a status light: every label leads with "MCP …"
 * so it reads as the tool's status, never the server's. "connected" never
 * appears before a real handshake. The native side owns the 5–10s on-open
 * timing; this function owns the TRUTH + the visibility *class*.
 *
 * Aggregation across both clients (an un-chosen second client is never an
 * error): connected wins, then ready, then any broken install (repair /
 * wrong-server) as a persistent badge, else the quiet install prompt.
 */
export function deriveIndicator(statuses: readonly ClientStatus[]): Indicator {
  const kinds = new Set(statuses.map((s) => s.kind));
  if (kinds.has('connected')) {
    return { kind: 'connected', label: 'MCP connected', visibility: 'transient' };
  }
  if (kinds.has('ready')) {
    return { kind: 'ready', label: 'MCP ready', visibility: 'transient' };
  }
  if (kinds.has('repair') || kinds.has('reinstall')) {
    return { kind: 'repair', label: 'MCP needs repair', visibility: 'persistent' };
  }
  return { kind: 'install', label: 'Install MCP', visibility: 'snoozable' };
}

export interface Indicator {
  kind: IndicatorKind;
  label: string;
  visibility: IndicatorVisibility;
}

/** The two clients, in display order, with their human names + bridge keys. */
export const MCP_CLIENTS: ReadonlyArray<{
  key: keyof McpStatusResult;
  name: string;
}> = [
  { key: 'claudeCode', name: 'Claude Code' },
  { key: 'claudeDesktop', name: 'Claude Desktop' },
];
