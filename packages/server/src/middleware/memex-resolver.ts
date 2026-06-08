import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgMemberships } from "../db/schema.js";
import type { Memex, Namespace } from "../db/schema.js";

// memexResolver — path-based tenant resolution per std-2 / dec-3 of doc-15.
//
// Two responsibilities:
//   1. Host guard. The app is served only at `memex.ai` (prod), `int.memex.ai`
//      (staging), `www.memex.ai` (marketing), and dev variants. Any other host
//      returns 404 — namespaces and memexes are PATH segments, never subdomains
//      (std-2).
//   2. Path-based memex resolution. URLs of the shape `/<namespace>/<memex>/...`
//      (or `/api/<namespace>/<memex>/...`) resolve to a memex row, which is
//      attached to the request context for downstream handlers. Authorization
//      (caller is allowed to read this memex) is enforced per-route, not here.

export type MemexResolverEnv = {
  Variables: {
    namespace?: Namespace | null;
    memex?: Memex | null;
  };
};

// Hostnames the app intentionally serves on. Anything else 404s.
//   - `memex.ai`           — production apex (single-host: app + API + MCP)
//   - `www.memex.ai`       — marketing CDN (served separately, but health pings hit here)
//   - `int.memex.ai`       — staging apex (single-host: app + API + MCP, path-routed)
//   - `localhost`          — dev
//   - `127.0.0.1`/`0.0.0.0` — dev variants
export const ALLOWED_HOSTS = new Set([
  "memex.ai",
  "www.memex.ai",
  "int.memex.ai",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

// `/api/...` paths that NEVER carry a `<namespace>/<memex>` prefix:
// health, public share routes, auth, waitlist, install scripts, MCP, CLI auth,
// the namespace-picker endpoint, and the test-only fake.
const NON_TENANT_API_PREFIXES = [
  "/api/health",
  "/api/share/",
  "/api/auth/",
  "/api/auth", // exact
  "/api/waitlist",
  "/api/cli/auth/",
  "/api/cli/auth",
  "/api/mcp/tokens",
  "/api/me/",
  "/api/me",
  "/api/oauth/",
  "/api/oauth",
  "/api/onboarding/",
  "/api/onboarding", // exact — spec-206 first-run greeting gate (user-level)
  "/api/install",
  "/install.sh",
  "/install.ps1",
  "/api/__test__/",
  "/api/__test__",
  "/mcp",
];

export const hostGuard = createMiddleware(async (c, next) => {
  const host = (c.req.header("host") || "").split(":")[0].toLowerCase();
  if (!host) return next();
  if (!ALLOWED_HOSTS.has(host)) {
    // Per std-2: any subdomain (or unknown host) returns 404. App content is
    // served only on the canonical hosts above; tenancy lives in the URL path.
    return c.json({ error: "Not found" }, 404);
  }
  return next();
});

interface PathPrefix {
  namespaceSlug: string;
  memexSlug: string;
}

// First-segment names that are app-level API mounts, NOT tenant namespaces.
// When the URL is `/api/orgs/check` we don't want to try resolving "orgs" as a
// namespace and "check" as a memex; same logic for every other API mount. The
// reserved-slug list (services/shared/slug.ts) covers user-facing reservations;
// this list covers internal API path roots.
const RESERVED_API_ROOTS = new Set([
  "health",
  "share",
  "auth",
  "oauth",
  "waitlist",
  "cli",
  "mcp",
  "me",
  "onboarding",
  "orgs",
  "namespaces",
  "consent",
  "invites",
  "team",
  "backstage",
  "docs",
  "comments",
  "decisions",
  "tasks",
  "execution-plans",
  "llm",
  "drift",
  "__test__",
]);

// Parses `/<namespace>/<memex>/...` or `/api/<namespace>/<memex>/...` from a
// request path. Returns null when the path is a top-level reserved word
// (api, login, settings, etc.) or doesn't have at least two segments.
export function parseMemexPath(rawPath: string): PathPrefix | null {
  if (!rawPath.startsWith("/")) return null;
  // Strip query string defensively; Hono usually gives us a pure path.
  const path = rawPath.split("?")[0];

  // If under /api, peel that off and inspect the rest. Otherwise inspect from /.
  // Both shapes resolve identically: `/<ns>/<mx>/...` and `/api/<ns>/<mx>/...`.
  let stripped = path;
  if (stripped === "/api" || stripped.startsWith("/api/")) {
    stripped = stripped.slice(4); // remove "/api"
    if (stripped === "") return null;
  }
  // After stripping, should look like `/<ns>/<mx>/...` for tenant routes.
  if (!stripped.startsWith("/")) return null;
  const parts = stripped.slice(1).split("/");
  if (parts.length < 2) return null;
  const [first, second] = parts;
  if (!first || !second) return null;

  // The slug regex is the std-3 format. Anything that doesn't match is treated
  // as a non-tenant URL (so the resolver no-ops for `/login`, `/settings`, etc.).
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
  if (!SLUG_RE.test(first)) return null;
  if (!SLUG_RE.test(second)) return null;

  // Path roots reserved for API mounts can't be tenant namespaces.
  if (RESERVED_API_ROOTS.has(first)) return null;

  return { namespaceSlug: first, memexSlug: second };
}

// b-38 A4 — URL-encoded path separators (`%2F`, `%5C`) survive WHATWG URL
// normalization end-to-end, unlike bare `//` and `..` which are collapsed by
// Node's URL parser before reaching middleware. A request like
// `/api/%2Ffoo/bar/docs` used to slip through parseMemexPath silently —
// sessionMiddleware then auto-resolved a single-membership user to their own
// memex regardless of what URL they typed (a debugging footgun, not an IDOR).
const ENCODED_PATH_SEPARATOR = /%2[Ff]|%5[Cc]/;

export const memexResolver = createMiddleware<MemexResolverEnv>(async (c, next) => {
  const path = c.req.path;

  // Reject URL-encoded path separators before anything else. Done unconditionally
  // (not just for /api/ paths) so browser routes can't smuggle them either.
  if (ENCODED_PATH_SEPARATOR.test(path)) {
    return c.json({ error: "Malformed path" }, 400);
  }

  // Fast path for /api routes that are intentionally non-tenant. Without this
  // skip, /api/health and /api/auth/login would try to resolve "auth/login" as
  // a (namespace, memex) pair — wasted DB query that always returns null.
  for (const exempt of NON_TENANT_API_PREFIXES) {
    if (exempt.endsWith("/")) {
      if (path.startsWith(exempt)) return next();
    } else if (path === exempt || path.startsWith(exempt + "/")) {
      return next();
    }
  }

  const parsed = parseMemexPath(path);
  if (!parsed) return next();

  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, parsed.namespaceSlug),
  });
  if (!ns) {
    // Per std-7: 404 (not 403) for unauthorized / not-found resources. We don't
    // even try to distinguish "namespace doesn't exist" from "user can't see it".
    return c.json({ error: "Not found" }, 404);
  }
  const mx = await db.query.memexes.findFirst({
    where: and(
      eq(memexes.namespaceId, ns.id),
      eq(memexes.slug, parsed.memexSlug),
    ),
  });
  if (!mx) return c.json({ error: "Not found" }, 404);

  c.set("namespace", ns);
  c.set("memex", mx);
  return next();
});

// Helper for downstream handlers that have access to a User and need to
// confirm membership in the resolved memex. Personal namespaces are only
// readable by their owner; org namespaces require an active org_membership.
export async function isMemberOfMemex(userId: string, memex: Memex, namespace: Namespace): Promise<boolean> {
  if (namespace.kind === "user") {
    return namespace.ownerUserId === userId;
  }
  if (namespace.kind === "org") {
    if (!namespace.ownerOrgId) return false;
    const m = await db.query.orgMemberships.findFirst({
      where: and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.orgId, namespace.ownerOrgId),
        eq(orgMemberships.status, "active"),
      ),
    });
    return !!m;
  }
  return false;
}
