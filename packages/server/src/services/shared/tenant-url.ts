// URL builders for outbound links (email bodies, MCP verbose responses).
//
// Per [std-2]: tenant routing is path-based on a single app host. Two hosts:
//   - https://int.memex.ai   (staging / int)
//   - https://memex.ai       (prod)
// Plus the dev fallback http://localhost:5173.
//
// The host comes from APP_BASE_URL (set per-env by deploy-config). Namespace +
// memex are URL **path** segments, never subdomains. The legacy subdomain
// builder (`<slug>.<host>`) is gone — it produced URLs like
// `https://mindset-int.int.memex.ai/briefs/b-9` that 404 against path-based
// `memexResolver`.

function originFromEnv(): string {
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:5173";
  return new URL(appBaseUrl).origin;
}

/**
 * Base URL of the app for the current env — host + scheme only, no path.
 * Use for flat / caller-scoped routes (e.g. `/verify-domain/:token`,
 * `/install.sh`) that don't carry a tenant in the URL.
 */
export function buildAppBaseUrl(): string {
  return originFromEnv();
}

/**
 * Canonical tenant URL: `${host}/<namespace>/<memex>`. Use as the base for
 * doc-level URLs in verbose tool responses and outbound email bodies.
 * Formatters append `/briefs/<handle>`, `/standards/<handle>`, etc. on top.
 */
export function buildTenantUrl(slugs: { namespace: string; memex: string }): string {
  return `${originFromEnv()}/${slugs.namespace}/${slugs.memex}`;
}
