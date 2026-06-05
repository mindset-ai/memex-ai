// Shared config for the post-deploy smoke suite (b-70 / dec-1).
//
// The smoke suite is deliberately NOT like __e2e__: where __e2e__ drives the
// app in-process via Hono `app.fetch()` against local Postgres, the smoke suite
// `fetch()`es a configurable, already-deployed live host over real HTTP. So the
// only "config" it needs is a base URL (+ optional credentials for the authed
// tier). Everything here is env-driven so `make smoke-int` / `make smoke-prod`
// can point the same suite at different deployed hosts.
//
// `make smoke-{int,prod}` sources scripts/deploy-config.sh and exports
// SMOKE_BASE_URL=https://$PUBLIC_HOST + SMOKE_ENV=$ENV before invoking vitest.

/** Strip a trailing slash so callers can always do `${baseUrl}/path`. */
function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/** Which deployed environment we're smoking, when known (`int` | `prod` | unset). */
export const SMOKE_ENV = process.env.SMOKE_ENV ?? "";

/**
 * The live host the suite hits over real HTTP. Defaults to int so a bare
 * `vitest run --config vitest.smoke.config.ts` (no env) still targets a real
 * deployed host rather than localhost — the smoke family is post-deploy by
 * definition (see b-70 s-2).
 */
export const SMOKE_BASE_URL = normalizeBaseUrl(
  process.env.SMOKE_BASE_URL ?? "https://int.memex.ai",
);

/** The `/mcp` endpoint on the smoked host. */
export const SMOKE_MCP_URL = `${SMOKE_BASE_URL}/mcp`;

/**
 * Authed-tier credentials (dec-2/3). Absent today (the smoke `mxt_` token is
 * provisioned by t-9 — Secret Manager + PAM, externally gated), so the authed
 * tier skips cleanly via `describe.skipIf(!SMOKE_MCP_TOKEN)` until it exists.
 */
export const SMOKE_MCP_TOKEN = process.env.SMOKE_MCP_TOKEN ?? "";

/**
 * Session JWT for the smoke user (spec-156 ac-13). The SSE routes sit behind
 * sessionMiddleware, which resolves session JWTs ONLY — mxt_ tokens are an
 * /mcp-side credential (app.ts → verifyMcpToken) and never reach the session
 * path. So the e2e SSE tier needs BOTH: SMOKE_MCP_TOKEN to drive /mcp writes
 * and SMOKE_SESSION_TOKEN to hold the stream open. Minted alongside the PAT by
 * `tsx src/db/seed-smoke.ts` (expires — see the script for rotation).
 */
export const SMOKE_SESSION_TOKEN = process.env.SMOKE_SESSION_TOKEN ?? "";

/**
 * Optional Postgres URL the telemetry-smoke tier connects to. Absent in the
 * pure-HTTP smoke setup; populated by callers that have spun up a
 * cloud-sql-proxy to the target env's Cloud SQL instance (see the
 * `smoke-int-with-db` / `smoke-prod-with-db` make targets). When unset the
 * telemetry smoke skips cleanly — pure HTTP probes still run.
 */
export const SMOKE_DATABASE_URL = process.env.SMOKE_DATABASE_URL ?? "";

/**
 * The throwaway namespace the authed tier owns and self-cleans inside
 * (dec-2). Reserved as an obvious non-production slug. The authed tier MUST
 * NEVER touch any other namespace/memex on the shared host.
 */
export const SMOKE_NAMESPACE = process.env.SMOKE_NAMESPACE ?? "zzz-smoke/main";

/**
 * Per-env default canonical ref for the folded-in canonical-refs check (the
 * de-drifted seed from scripts/smoke-canonical-refs.ts — its old default was
 * the stale, pre-migration `mindset-int/memex-app/briefs/b-36`). b-1 is the
 * founding spec in each namespace and is the most stable choice per env:
 *   - prod renamed `mindset-int/memex-app` → `mindset-prod/memex-building-itself`
 *     during the b-65 migration; b-1 survived the rename.
 *   - int still serves the original `mindset-int/memex-app/*` namespace.
 * Override with SMOKE_CANONICAL_REF for ad-hoc runs.
 */
export const SMOKE_CANONICAL_REF =
  process.env.SMOKE_CANONICAL_REF ??
  (SMOKE_ENV === "prod"
    ? "mindset-prod/memex-building-itself/briefs/b-1"
    : "mindset-int/memex-app/briefs/b-1");

interface McpResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

/**
 * Call an MCP tool on the live `/mcp` endpoint with the smoke bearer token.
 * Mirrors the transport handling in scripts/smoke-canonical-refs.ts: the MCP
 * server replies either as plain JSON or as a single SSE `data:` line.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  token: string = SMOKE_MCP_TOKEN,
): Promise<{ status: number; body: McpResponse; raw: string }> {
  const res = await fetch(SMOKE_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const raw = await res.text();
  let body: McpResponse;
  // The MCP streamable-HTTP transport may reply as plain JSON OR as an SSE
  // frame. The SSE frame can lead with an `event: message` line before the
  // `data:` line, so detect the data line anywhere rather than requiring the
  // body to *start* with `data:`.
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) {
    body = JSON.parse(dataLine.slice(5).trim()) as McpResponse;
  } else {
    body = raw ? (JSON.parse(raw) as McpResponse) : {};
  }
  return { status: res.status, body, raw };
}

/** Flatten an MCP tool result's text content blocks into a single string. */
export function mcpTextPayload(body: McpResponse): string {
  return (body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

interface InitializeResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name?: string; version?: string };
    /** Server-published operating guidance shipped in the initialize handshake.
     *  Per Anthropic's MCP docs this field is truncated at 2KB on Claude Code,
     *  so the live deployed length is itself a contract worth smoking. */
    instructions?: string;
  };
  error?: { code?: number; message?: string };
}

/**
 * Send an MCP `initialize` JSON-RPC to the live host with the smoke bearer
 * token, and return the parsed `result` (server identity + capabilities +
 * instructions). Used by the smoke suite to assert the LIVE deployed
 * instructions string honours the 2KB Claude Code truncation cap and carries
 * the load-bearing tokens — the unit-test regression guard only checks the
 * source string, this confirms the cap is honoured AS DELIVERED over HTTP.
 */
export async function callMcpInitialize(
  token: string = SMOKE_MCP_TOKEN,
): Promise<{ status: number; body: InitializeResponse; raw: string }> {
  const res = await fetch(SMOKE_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "memex-smoke", version: "1.0" },
      },
    }),
  });
  const raw = await res.text();
  let body: InitializeResponse;
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine) {
    body = JSON.parse(dataLine.slice(5).trim()) as InitializeResponse;
  } else {
    body = raw ? (JSON.parse(raw) as InitializeResponse) : {};
  }
  return { status: res.status, body, raw };
}
