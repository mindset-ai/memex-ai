// Shared HTTP infrastructure for the admin API client. Extracted so future per-domain
// modules (api/auth.ts, api/accounts.ts, api/docs.ts, api/share.ts) can depend on this
// without pulling in the rest of client.ts.
//
// Public surface:
//   - BASE_URL — '/api' (or VITE_API_URL override)
//   - fetchWithRetry — fetch wrapper with 502/503 backoff + auto-auth
//   - authHeaders — explicit Authorization header builder
//   - isPublicPath — predicate for endpoints that must NOT receive Authorization
//   - tenantBase — '/api/<namespace>/<memex>' for the current browsing context
//
// t-18 of doc-15 (F.3 / dec-3): tenancy-scoped surfaces moved from flat
// `/api/<resource>` paths to `/api/<namespace>/<memex>/<resource>`. t-23
// flipped the React UI router from subdomain-based to path-based, so the
// `(namespace, memex)` pair now comes straight from `window.location.pathname`.
// No subdomain parsing, no membership lookup — the browser URL is the source
// of truth.

export const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

const MAX_RETRIES = 2;
const INITIAL_DELAY_MS = 1000;

// Paths that must NOT receive the Authorization header — they're public by design.
// Everything else auto-attaches the stored session token so account-scoped endpoints
// (gated by sessionMiddleware) get authenticated requests by default.
const PUBLIC_PATH_PREFIXES = ['/share/', '/orgs/domains/verify/', '/waitlist'];

export function isPublicPath(url: string): boolean {
  // `url` may be a full URL or a relative path like `/api/foo`. Check the path portion.
  const path = url.startsWith('http') ? new URL(url).pathname : url;
  return PUBLIC_PATH_PREFIXES.some((p) => path.includes(p));
}

// Resolve the current tenant from the browser URL path. t-23: the React UI
// router is now path-based, so `(namespace, memex)` lives in the first two
// URL segments. We parse them directly with no membership lookup or hostname
// inspection — the path *is* the tenant context.
//
// Returns null on caller-scoped routes (login, share, invite, settings, …)
// and on the bare root path. Callers fall back to flat `/api/...` (caller-
// scoped endpoints like /api/me, /api/orgs, /api/auth/* always go flat).
import { parseTenantFromPathname } from '../utils/tenantUrl';

/**
 * Build the tenant-scoped base path used by F.3 of doc-15 routes:
 * `/api/<namespace>/<memex>`. Returns null when not in a tenant context —
 * callers should fall back to `BASE_URL` for caller-scoped routes (auth, me,
 * orgs, consent, cli/auth, share). Mostly used by the domain modules in
 * api/client.ts.
 *
 * On flat pages (e.g. `/org`, `/settings/tokens`) the URL carries no tenant
 * prefix but the session still knows which Memex the user last resolved to —
 * we walk session.memberships to recover the slug + memexSlug so admin API
 * calls (which only mount under the tenant prefix) still work.
 */
export function tenantBase(): string | null {
  if (typeof window === 'undefined') return null;
  const t = parseTenantFromPathname(window.location.pathname);
  if (t) return `${BASE_URL}/${t.namespace}/${t.memex}`;
  // URL has no tenant — try to recover from the cached session.
  return tenantBaseFromSession();
}

function tenantBaseFromSession(): string | null {
  try {
    const raw = window.localStorage.getItem('memex-session');
    if (!raw) return null;
    const session = JSON.parse(raw) as {
      currentMemexId?: string | null;
      memberships?: Array<{
        memexId: string;
        slug: string;
        memexSlug?: string;
      }>;
    };
    if (!session.currentMemexId) return null;
    const match = session.memberships?.find(
      (m) => m.memexId === session.currentMemexId,
    );
    if (!match || !match.memexSlug) return null;
    return `${BASE_URL}/${match.slug}/${match.memexSlug}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the tenant-scoped base path, throwing when the caller is on the bare
 * domain. Use this from helpers that are NEVER expected to run outside a
 * tenant context (e.g. fetchDocs). Routes that should fall back to the flat
 * surface call `tenantBase()` directly and branch on null.
 */
export function requireTenantBase(): string {
  const base = tenantBase();
  if (!base) {
    throw new Error(
      'Tenant context required: this API call must be made from a memex subdomain. ' +
        'If you are on the bare domain, the call should target the caller-scoped surface instead.',
    );
  }
  return base;
}

function withAutoAuth(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (isPublicPath(url)) return init;
  const existingHeaders = new Headers(init?.headers ?? {});

  // Attach Authorization if not already set and a token is stored. Tenancy
  // travels in the URL path (/api/<namespace>/<memex>/...) — see tenantBase()
  // below, which is the single source of the prefix for client call sites.
  if (existingHeaders.has('Authorization')) return init;
  const token =
    typeof window !== 'undefined' ? window.localStorage.getItem('memex-auth-token') : null;
  if (!token) return init;
  existingHeaders.set('Authorization', `Bearer ${token}`);
  return { ...init, headers: existingHeaders };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const finalInit = withAutoAuth(input, init);
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(input, finalInit);
      if ((res.status === 502 || res.status === 503) && attempt < MAX_RETRIES) {
        await delay(INITIAL_DELAY_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await delay(INITIAL_DELAY_MS * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastError;
}

// Explicit Authorization header builder — used by the auth-flow endpoints that take a
// `token` parameter directly (signup/login/SSO/etc.) rather than relying on the
// localStorage auto-attach in withAutoAuth.
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
