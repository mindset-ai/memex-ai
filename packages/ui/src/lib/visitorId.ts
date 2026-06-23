// Browser visitor_id — the consent-gated client mint (spec-254 t-3).
//
// The client OWNS the mint (dec-4 = B): a visitor_id is resolved, persisted, and
// carried ONLY after consent. Persistence is a first-party cookie scoped
// Domain=.memex.ai (so www + app share it, and the server's visitorMiddleware
// reads it) mirrored to localStorage. ?aid= (the marketing handoff) is adopted over
// a freshly-minted id. Nothing is written without consent (hasConsent()).
//
// The cookie name + domain are kept in lockstep with the server
// (packages/server/src/middleware/visitor.ts); the std-28 e2e journey catches drift.

import { hasConsent } from './visitorConsent';

export const VISITOR_COOKIE = 'memex_vid';
export const VISITOR_LS_KEY = 'memex.visitor_id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWO_YEARS_SEC = 60 * 60 * 24 * 730;

function isUuid(v: string | null | undefined): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ".memex.ai" on deployed hosts (cross-property); host-only (no Domain) on
// localhost / IPs in dev + tests. Mirrors server visitorCookieDomain().
function domainAttr(): string {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  return host === 'memex.ai' || host.endsWith('.memex.ai') ? '; Domain=.memex.ai' : '';
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${TWO_YEARS_SEC}; SameSite=Lax${domainAttr()}`;
}

function deleteCookie(name: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${domainAttr()}`;
}

function readStored(): string | undefined {
  const fromCookie = readCookie(VISITOR_COOKIE);
  if (isUuid(fromCookie)) return fromCookie;
  try {
    const fromLs = localStorage.getItem(VISITOR_LS_KEY);
    if (isUuid(fromLs)) return fromLs;
  } catch {
    /* localStorage unavailable */
  }
  return undefined;
}

function inboundAid(): string | undefined {
  try {
    const aid = new URLSearchParams(location.search).get('aid');
    return isUuid(aid) ? aid : undefined;
  } catch {
    return undefined;
  }
}

function persist(id: string): void {
  writeCookie(VISITOR_COOKIE, id);
  try {
    localStorage.setItem(VISITOR_LS_KEY, id);
  } catch {
    /* cookie is the canonical carrier; the localStorage mirror is best-effort */
  }
}

/**
 * Resolve + persist the visitor_id, but ONLY when consent is granted (dec-4 = B).
 * Precedence: inbound ?aid= (marketing handoff) > existing stored id > a fresh
 * crypto.randomUUID(). Returns the id, or null when consent is absent (nothing is
 * written). Idempotent: a second call with the same stored id returns it unchanged.
 */
export function resolveVisitorIdWithConsent(): string | null {
  if (!hasConsent()) return null;
  const id = inboundAid() ?? readStored() ?? crypto.randomUUID();
  persist(id);
  return id;
}

/** The current visitor_id without minting — null when none or consent absent. */
export function currentVisitorId(): string | null {
  if (!hasConsent()) return null;
  return readStored() ?? null;
}

/** Withdraw / decline: clear the durable id from both carriers. */
export function clearVisitorId(): void {
  deleteCookie(VISITOR_COOKIE);
  try {
    localStorage.removeItem(VISITOR_LS_KEY);
  } catch {
    /* nothing to clear */
  }
}
