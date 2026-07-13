// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { NotFoundError, ShareAccessError } from './errors';
import { BASE_URL, fetchWithRetry, authHeaders } from './http';
import { tBase } from './internal';

export type MemexVisibility = 'public' | 'private';

export interface MemexVisibilityDto {
  id: string;
  namespaceId: string;
  slug: string;
  name: string;
  visibility: MemexVisibility;
}

/**
 * Read a single Memex's public-facing shape (id/slug/name/visibility). Public
 * memexes are readable by anyone; private memexes 404 for non-members (std-7).
 */
export async function fetchMemexApi(
  memexId: string,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    if (res.status === 404) throw new NotFoundError(`Memex not found: ${memexId}`);
    throw new Error(`Failed to fetch memex: ${res.status}`);
  }
  const body = (await res.json()) as { memex: MemexVisibilityDto };
  return body.memex;
}

/**
 * Flip a Memex's visibility (public ⇄ private). Owner/admin-gated server-side
 * (adminGate); non-admins / anonymous callers get 403 / 401. The change takes
 * effect on the next read immediately.
 */
export async function updateMemexVisibilityApi(
  memexId: string,
  visibility: MemexVisibility,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ visibility }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `Update visibility failed: ${res.status}`);
  }
  return (body as { memex: MemexVisibilityDto }).memex;
}

/**
 * Rename a Memex's display name (spec-479). Owner/admin-gated server-side; the
 * URL/slug is untouched. Returns the updated row.
 */
export async function updateMemexNameApi(
  memexId: string,
  name: string,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `Rename failed: ${res.status}`);
  }
  return (body as { memex: MemexVisibilityDto }).memex;
}

/**
 * Rename a Memex's URL slug (spec-479). Owner/admin-gated. The server writes a
 * memex_rename redirect so old links keep working; a slug that is taken or
 * reserved by a prior rename returns 409 (surfaced as the thrown message). The
 * returned row carries the new slug — the caller navigates to the new URL.
 */
export async function renameMemexSlugApi(
  memexId: string,
  slug: string,
  token: string | null,
): Promise<MemexVisibilityDto> {
  const res = await fetchWithRetry(`${tBase()}/memexes/${memexId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ slug }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? body.message ?? `Rename failed: ${res.status}`);
  }
  return (body as { memex: MemexVisibilityDto }).memex;
}

/** The public-facing Memex shape returned by the slug-based readability probe. */
export interface PublicMemexProbe {
  id: string;
  namespaceId: string;
  slug: string;
  name: string;
  visibility: MemexVisibility;
}

/**
 * spec-111 — anonymous readability probe for a tenant Memex. Hits the slug-based
 * GET /api/<namespace>/<memex>/memexes (publicSessionMiddleware + canReadMemex):
 * 200 + the Memex when it's publicly readable, 404 when it's private/unknown to
 * an anonymous caller (std-7). TenantLayout uses the result to choose the
 * read-only public shell vs bounce-to-login for a visitor with no session, and
 * to feed the Memex name + visibility into PageHeader (an anonymous visitor has
 * no membership row to read those from). Sends NO auth header by design — it
 * answers "can an ANONYMOUS visitor read this?". Returns null on any non-2xx /
 * network error so the caller defaults to the safe (login) path.
 */
export async function probePublicMemex(
  namespace: string,
  memexSlug: string,
): Promise<PublicMemexProbe | null> {
  try {
    const res = await fetch(`${BASE_URL}/${namespace}/${memexSlug}/memexes`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { memex?: PublicMemexProbe };
    return body.memex ?? null;
  } catch {
    return null;
  }
}

// ── Share links (t-10) ──

export interface ShareTokenDto {
  id: string;
  documentId: string;
  token: string;
  revoked: boolean;
  createdAt: string;
}

export async function createShareLinkApi(
  docId: string,
  token: string | null,
): Promise<ShareTokenDto> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  });
  if (!res.ok) {
    throw new Error(`Create share link failed: ${res.status}`);
  }
  return res.json();
}

export async function listShareLinksApi(
  docId: string,
  token: string | null,
): Promise<ShareTokenDto[]> {
  const res = await fetchWithRetry(`${tBase()}/docs/${docId}/shares`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`List share links failed: ${res.status}`);
  }
  return res.json();
}

export async function revokeShareLinkApi(
  shareId: string,
  token: string | null,
): Promise<ShareTokenDto> {
  const res = await fetchWithRetry(`${tBase()}/docs/shares/${shareId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Revoke share link failed: ${res.status}`);
  }
  return res.json();
}

export interface SharedCommentDto {
  id: string;
  memexId: string;
  sectionId: string | null;
  decisionId: string | null;
  taskId: string | null;
  authorName: string;
  authorUserId: string | null;
  authorNamespaceId: string | null;
  content: string;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SharedDocumentDto {
  doc: {
    id: string;
    memexId: string;
    handle: string;
    title: string;
    docType: string;
    status: string;
    createdAt: string;
    statusChangedAt: string;
  };
  sections: Array<{
    id: string;
    docId: string;
    sectionType: string;
    title: string | null;
    content: string;
    seq: number;
    createdAt: string;
    updatedAt: string;
  }>;
  namespaceSlug: string;
  memexName: string;
  comments: SharedCommentDto[];
}

// PUBLIC endpoint — no Authorization header sent.
export async function getSharedDocumentApi(shareToken: string): Promise<SharedDocumentDto> {
  const res = await fetchWithRetry(`${BASE_URL}/share/${shareToken}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason: 'unknown' | 'revoked' = body.reason === 'revoked' ? 'revoked' : 'unknown';
    throw new ShareAccessError(reason, body.error ?? `Share access failed: ${res.status}`);
  }
  return body;
}

// External comment POST (t-11). Bearer token required — the commenter must be a Memex user
// (any account works; the server records their account for "External" badge computation).
export async function postSharedCommentApi(
  shareToken: string,
  bearerToken: string | null,
  target: { kind: 'section' | 'decision' | 'task'; id: string },
  content: string,
): Promise<SharedCommentDto> {
  const res = await fetchWithRetry(`${BASE_URL}/share/${shareToken}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
    body: JSON.stringify({ target, content }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.reason === 'revoked' || body.reason === 'unknown') {
      throw new ShareAccessError(body.reason, body.error ?? 'Share access failed');
    }
    throw new Error(body.error ?? `Comment failed: ${res.status}`);
  }
  return body;
}
