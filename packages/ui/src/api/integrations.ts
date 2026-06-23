// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { OrgApiError } from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { BASE_URL, fetchWithRetry, authHeaders } from './http';

export interface OrgSlackStatus {
  orgId: string | null;
  orgName: string;
  personal: boolean;
  connected: boolean;
  workspaceName?: string;
  displayName?: string;
  slackWorkspaceId?: string;
}

export async function getSlackStatusApi(token: string | null): Promise<OrgSlackStatus[]> {
  return fetchJsonRaw<OrgSlackStatus[]>(
    fetchWithRetry,
    `${BASE_URL}/auth/slack`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

// ── Discord webhook settings (spec-138) ──────────────────────────────────────
// Mounted at /api/:namespace/:memex/discord-webhook — all calls use tBase().

export interface DiscordWebhookStatus {
  connected: boolean;
  channelName?: string | null;
  webhookUrlPreview?: string;
}

function discordBase(namespace: string, memex: string): string {
  return `${BASE_URL}/${namespace}/${memex}/discord-webhook`;
}

export async function getDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
): Promise<DiscordWebhookStatus> {
  return fetchJsonRaw<DiscordWebhookStatus>(
    fetchWithRetry,
    discordBase(namespace, memex),
    { method: 'GET', headers: authHeaders(token) },
  );
}

export async function saveDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
  webhookUrl: string,
  channelName?: string,
): Promise<DiscordWebhookStatus> {
  return fetchJsonRaw<DiscordWebhookStatus>(
    fetchWithRetry,
    discordBase(namespace, memex),
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl, channelName }),
    },
  );
}

export async function deleteDiscordWebhookApi(
  token: string | null,
  namespace: string,
  memex: string,
): Promise<void> {
  await fetchJsonRaw<{ connected: boolean }>(
    fetchWithRetry,
    discordBase(namespace, memex),
    { method: 'DELETE', headers: authHeaders(token) },
  );
}

export async function disconnectSlackApi(token: string | null, orgId: string | null): Promise<void> {
  const qs = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
  await fetchJsonRaw<{ revoked: boolean }>(
    fetchWithRetry,
    `${BASE_URL}/auth/slack${qs}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
}

export async function consumeDomainVerificationApi(verifyToken: string): Promise<{
  domain: string;
  method: 'sso' | 'email';
  verifiedAt: string;
}> {
  // Public — no auth required (the token is the proof).
  const res = await fetchWithRetry(`${BASE_URL}/orgs/domains/verify/${verifyToken}`, {
    method: 'POST',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OrgApiError(
      res.status,
      body.error,
      body.reason,
      body.message ?? body.error ?? `Verify domain failed: ${res.status}`,
    );
  }
  return body;
}
