// CORS allowlist — per std-2 / dec-11, tenants are path segments not subdomains,
// so the allowlist is a small fixed set of canonical hosts. Marketing on
// `www.memex.ai` is a separate origin served from the CDN and calls the app
// cross-origin for the public waitlist endpoint (b-9), so it is allowlisted
// here. `int.memex.ai` is the staging env.
//
// Local dev allows the Vite dev server (5173) plus a port for legacy demos
// (8000).
//
// Claude origins (claude.ai, claude.com, *.anthropic.com) are allowlisted for
// the Anthropic Connectors Directory listing (b-31): when a user adds Memex as
// a connector from claude.ai, the OAuth + MCP requests originate from those
// hosts. Suffix matching for *.anthropic.com uses a leading-dot guard so
// `evil-anthropic.com` cannot impersonate `app.anthropic.com`.

export const ALLOWED_ORIGINS = new Set([
  "https://memex.ai",
  "https://www.memex.ai",
  "https://int.memex.ai",
  "http://localhost:5173",
  "http://localhost:8000",
  "https://claude.ai",
  "https://claude.com",
]);

export const ALLOWED_ORIGIN_SUFFIXES = [".anthropic.com"];

export function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix));
}
