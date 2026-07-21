// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { BASE_URL, fetchWithRetry, authHeaders } from './http';
import { tBase } from './internal';

export interface CliAuthLookupResult {
  status: 'pending' | 'completed' | 'consumed';
  expiresAt: string;
}

export async function lookupCliAuthApi(
  code: string,
  token: string | null,
): Promise<CliAuthLookupResult | null> {
  const res = await fetchWithRetry(`${BASE_URL}/cli/auth/lookup?code=${encodeURIComponent(code)}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Lookup failed: ${res.status}`);
  }
  return res.json();
}

export async function completeCliAuthApi(
  code: string,
  label: string,
  token: string | null,
): Promise<void> {
  const res = await fetchWithRetry(`${BASE_URL}/cli/auth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ code, label }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Authorize failed: ${res.status}`);
  }
}

export interface McpTokenSummary {
  id: string;
  label: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function listMcpTokensApi(
  token: string | null,
  init?: { signal?: AbortSignal },
): Promise<McpTokenSummary[]> {
  const res = await fetchWithRetry(`${BASE_URL}/mcp/tokens`, {
    headers: authHeaders(token),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw new Error(`List MCP tokens failed: ${res.status}`);
  return res.json();
}

/** Mint response — carries the raw `mxt_` token exactly once (never returned again). */
export interface MintedMcpToken {
  token: string;
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
}

// Session-mint (spec-304 t-10): mint an MCP token straight from the logged-in
// web session — the desktop app's in-app install path, with no CLI device flow.
// The raw `mxt_` token is in the response exactly once (it's stored hashed);
// hand it to the native installMcp bridge immediately. `label` defaults
// server-side to "Memex Desktop" when omitted.
export async function mintMcpTokenApi(
  label: string | undefined,
  token: string | null,
): Promise<MintedMcpToken> {
  const res = await fetchWithRetry(`${BASE_URL}/mcp/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(label ? { label } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `Mint MCP token failed: ${res.status}`);
  }
  return body as MintedMcpToken;
}

export async function revokeMcpTokenApi(
  id: string,
  token: string | null,
): Promise<McpTokenSummary> {
  const res = await fetchWithRetry(`${BASE_URL}/mcp/tokens/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `Revoke failed: ${res.status}`);
  }
  return res.json();
}

// ── Emission keys (spec-129) — per-Memex keys gating POST /api/test-events ──
// Memex-scoped, like fetchMemexApi: the route resolves the Memex from the tenant path, so
// these calls hit `${tBase()}/emission-keys`. The raw key is returned ONCE by generate;
// list/revoke only ever expose the non-secret prefix.

export interface EmissionKeySummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  // spec-234: the two-key discriminator. A permanent / CI key (human-minted) has both
  // null. An ephemeral / agent key (minted by provision_ac_emission over MCP) carries an
  // `expiresAt` and is `scopedSpecHandle`-locked to a single Spec.
  expiresAt: string | null;
  scopedSpecHandle: string | null;
}

/** Generate response — carries the raw `key` exactly once (never returned again). */
export interface GeneratedEmissionKey extends EmissionKeySummary {
  key: string;
}

export async function listEmissionKeysApi(
  token: string | null,
): Promise<EmissionKeySummary[]> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`List emission keys failed: ${res.status}`);
  return res.json();
}

export async function generateEmissionKeyApi(
  name: string,
  token: string | null,
): Promise<GeneratedEmissionKey> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body.error ?? body.message ?? `Generate emission key failed: ${res.status}`,
    );
  }
  return body as GeneratedEmissionKey;
}

export async function revokeEmissionKeyApi(
  id: string,
  token: string | null,
): Promise<EmissionKeySummary> {
  const res = await fetchWithRetry(`${tBase()}/emission-keys/${id}/revoke`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body.error ?? body.message ?? `Revoke emission key failed: ${res.status}`,
    );
  }
  return body as EmissionKeySummary;
}
