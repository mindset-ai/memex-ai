// Remember the tenant the user was last working in, so returning to the app (the
// bare URL, /login, or a bounce off an invalid tenant) lands them back where they
// were — not on their personal Memex by default.
//
// Persisted in localStorage (survives reloads and new sessions, like the auth
// token). It is validated against the live session on read (see
// computeReturnLanding in AuthContext), so a lost membership, a renamed slug, or a
// different signed-in user falls back cleanly to the personal default. Only real,
// writable workspaces are recorded — never the read-only Explore/visited memexes.

const KEY = 'memex-last-tenant';

export interface LastTenant {
  ns: string;
  mx: string;
}

export function recordLastMemex(ns: string, mx: string): void {
  try {
    if (!ns || !mx) return;
    localStorage.setItem(KEY, JSON.stringify({ ns, mx }));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function readLastMemex(): LastTenant | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastTenant>;
    if (typeof parsed?.ns === 'string' && typeof parsed?.mx === 'string' && parsed.ns && parsed.mx) {
      return { ns: parsed.ns, mx: parsed.mx };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearLastMemex(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
