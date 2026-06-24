// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchWithRetry, authHeaders } from './http';
import { BASE_URL } from './http';

export interface OAuthAuthorizePreview {
  client_name: string;
  scopes: string[];
  // spec-307: no per-grant Org scope — an OAuth grant covers the user's full live
  // membership, so the preview no longer carries an Org list.
}

export interface OAuthAuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
}

export async function oauthAuthorizePreviewApi(
  params: OAuthAuthorizeParams,
  token: string | null,
): Promise<OAuthAuthorizePreview> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  const res = await fetchWithRetry(`${BASE_URL}/oauth/authorize/preview?${qs}`, {
    headers: authHeaders(token),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error_description ?? body.error ?? `Preview failed: ${res.status}`;
    const e = new Error(msg);
    (e as Error & { status?: number }).status = res.status;
    throw e;
  }
  return body;
}

export async function oauthAuthorizeDecisionApi(
  params: OAuthAuthorizeParams,
  decision: 'allow' | 'deny',
  token: string | null,
): Promise<{ redirect: string }> {
  // spec-307: no Org scope on the grant — the body carries no org_id. The grant
  // covers the user's full live membership.
  const res = await fetchWithRetry(`${BASE_URL}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      ...params,
      decision,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description ?? body.error ?? `Authorize failed: ${res.status}`);
  }
  return body;
}
