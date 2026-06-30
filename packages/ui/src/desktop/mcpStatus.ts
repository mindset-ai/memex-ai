// spec-304 t-55 (dec-20, dec-21 → ac-48, ac-49): the PURE status derivation for
// the in-app MCP install surface. The desktop shell's `mcpStatus` bridge reports
// each Claude client's LOCAL config (installed / urlMatches / tokenPrefix); the
// server reports the user's ACTIVE tokens (by non-secret prefix, each carrying a
// `lastUsedAt`) and the MCP connection signal (the same `mcp.connected` milestone
// the onboarding journey reads). This module joins those truths client-side — no
// I/O, no React — so the classification is unit-testable in isolation.
//
// Two transports, two derivations (dec-23):
//  - Claude Code is TOKEN-based (an mxt_ HTTP entry in the local config). Its
//    "connected" is PER-TOKEN: the active token matching the local entry's prefix
//    has a non-null `lastUsedAt`, i.e. THAT token has actually hit /mcp. A fresh
//    mint is null until the client reconnects, so "connected" never appears before
//    a real handshake for this install (issue-23 / ac-52).
//  - Claude Desktop is CONNECTOR-based (an account-level Custom Connector added in
//    Claude, NOT in claude_desktop_config.json). It has no local entry to read, so
//    its status derives purely from the user-scoped `mcp.connected` signal
//    (issue-22 superseded; t-56 / ac-56).

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

/**
 * One of the user's active MCP tokens, as surfaced by `listMcpTokensApi` — the
 * non-secret `prefix` joins to a local config entry, and `lastUsedAt` is the
 * PER-TOKEN handshake signal: null until that token first hits /mcp, non-null
 * thereafter (issue-23 / ac-52).
 */
export interface ActiveToken {
  prefix: string;
  lastUsedAt: string | null;
}

export type ClientStatusKind =
  | 'not_installed'
  | 'ready' // installed + authorized, no handshake yet
  | 'connected' // installed + authorized + a real MCP handshake observed
  | 'repair' // installed but the token is revoked / unknown
  | 'reinstall'; // installed but pointing at a different server

export type ClientButton = 'install' | 'reinstall' | 'repair' | 'connector';

export type ClientTransport = 'token' | 'connector';

export interface ClientStatus {
  kind: ClientStatusKind;
  /** The per-client label shown in Settings → Integrations (s-17 table). */
  label: string;
  button: ClientButton;
}

/**
 * Classify a TOKEN-based client (Claude Code) by joining its local config with
 * the user's active tokens. A never-installed client is never an error (dec-20).
 * Precedence once installed: wrong-server → revoked/unknown-token → connected →
 * ready.
 *
 * "connected" is PER-TOKEN (issue-23 / ac-52): the active token matching the
 * local entry's prefix must carry a non-null `lastUsedAt` — proof that THIS
 * install's token has actually handshaked against /mcp. A freshly-minted token
 * is `lastUsedAt: null`, so a fresh (re)install reads "MCP ready" until Claude
 * reconnects — the user-scoped milestone can no longer paint it "connected"
 * prematurely.
 */
export function deriveClientStatus(
  local: McpTargetStatus | undefined,
  opts: { activeTokens: ReadonlyArray<ActiveToken> },
): ClientStatus {
  if (!local || !local.installed) {
    return { kind: 'not_installed', label: 'Not installed', button: 'install' };
  }
  if (!local.urlMatches) {
    return { kind: 'reinstall', label: 'Points elsewhere', button: 'reinstall' };
  }
  const match =
    local.tokenPrefix != null
      ? opts.activeTokens.find((t) => t.prefix === local.tokenPrefix)
      : undefined;
  if (!match) {
    return { kind: 'repair', label: 'Token invalid', button: 'repair' };
  }
  if (match.lastUsedAt != null) {
    return { kind: 'connected', label: 'MCP connected', button: 'reinstall' };
  }
  return { kind: 'ready', label: 'MCP ready', button: 'reinstall' };
}

/**
 * Classify a CONNECTOR-based client (Claude Desktop "Org Connector", dec-24,
 * revises dec-23/t-56). The account-level Custom Connector is NOT in
 * claude_desktop_config.json and is NOT an `mxt_` token in the user's token
 * list, so there is NO signal that can attribute a connection to THIS client.
 * The only thing available — the user-scoped `mcp.connected` milestone — is a
 * monotonic "have you ever connected by anything" flag (it stayed true even
 * after every memex entry was wiped, falsely painting the row "connected").
 *
 * So the connector NEVER asserts "connected" and NEVER drives the native pill
 * (the caller excludes connector clients from the pill aggregate). It is a
 * setup-only row: a neutral "Set up in Claude" inline status plus the
 * "Install for my org" instructions dialog. A false "not set up" prompt is
 * benign; a false "connected" is not. The precise "Last connected: <date>" /
 * "Never used" status — and the per-credential signal that powers it — are
 * deferred to issue-26.
 */
export function deriveConnectorStatus(): ClientStatus {
  return { kind: 'not_installed', label: 'Set up in Claude', button: 'connector' };
}

export type IndicatorKind = 'connected' | 'ready' | 'repair' | 'install';

export type IndicatorVisibility =
  | 'persistent' // an actionable error: stay until resolved
  | 'snoozable'; // a standing state the user may dismiss (success / opportunity)

/**
 * The single app-global indicator the native pill renders (dec-21, dec-25). The
 * pill is a PERSISTENT, user-dismissible status reflector: every state shows and
 * STAYS until the user dismisses it (or it's superseded) — there is no transient
 * auto-hide any more (dec-25 removed it). Every label leads with "MCP …" so it
 * reads as the tool's status, never the server's. "connected" never appears
 * before a real handshake. This function owns the TRUTH + the visibility *class*.
 *
 * Aggregation across both clients (an un-chosen second client is never an
 * error): connected wins, then ready, then any broken install (repair /
 * wrong-server) as a persistent badge, else the quiet install prompt.
 *
 * Two visibility classes remain: `persistent` (an actionable error — repair —
 * that must not be dismissable away) and `snoozable` (everything else: the
 * standing success/ready/install states the user may dismiss). Because the pill
 * is now the standing SUCCESS signal, a failed install ACTION surfaces its own
 * error in the Integrations surface + a native failure notification (t-70) —
 * the pill gains no new failure state.
 */
export function deriveIndicator(statuses: readonly ClientStatus[]): Indicator {
  const kinds = new Set(statuses.map((s) => s.kind));
  if (kinds.has('connected')) {
    // Connected is the standing SUCCESS signal: it shows and STAYS, dismissible
    // by the user (dec-25). No longer auto-hidden — the transient class is gone.
    return { kind: 'connected', label: 'MCP connected', visibility: 'snoozable' };
  }
  if (kinds.has('ready')) {
    // Ready = installed + authorized, no handshake yet. It STAYS visible like
    // the Install prompt (snoozable) — an actionable "go make Claude connect"
    // state (issue-31). It flips to "connected" once a handshake is observed.
    return { kind: 'ready', label: 'MCP ready', visibility: 'snoozable' };
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

/**
 * The two clients, in display order, with their human names, bridge keys, and
 * transport (dec-23): Claude Code installs a local HTTP token; Claude Desktop
 * connects via an account-level Custom Connector (instructions only).
 */
export const MCP_CLIENTS: ReadonlyArray<{
  key: keyof McpStatusResult;
  name: string;
  transport: ClientTransport;
}> = [
  { key: 'claudeCode', name: 'Claude Code', transport: 'token' },
  {
    key: 'claudeDesktop',
    name: 'Claude Desktop – Org Connector',
    transport: 'connector',
  },
];
