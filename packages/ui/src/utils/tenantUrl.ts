// Tenant URL helpers for the path-based router (std-2).
//
// The React UI router mounts tenancy-scoped routes under
// `<base>/:namespace/:memex/*`. Tenants share an origin — no subdomains, no
// cross-origin auth handoff.
//
//   buildTenantUrl(ns, mx, path)  → ${origin}/${ns}/${mx}${path}
//   buildBareDomainUrl(path)      → ${origin}${path}   (apex, no tenant prefix)
//   getCurrentTenant()            → { namespace, memex } | null   (from window.location.pathname)
//   tenantPath(path)              → `/${ns}/${mx}${path}` when in tenant context, else path

// Caller-scoped routes — these never live under /:namespace/:memex.
// Used by getCurrentTenant() to short-circuit before parsing.
const CALLER_SCOPED_PREFIXES = [
  "login",
  "onboarding",
  "share",
  "invite",
  "verify-email",
  "verify-email-gate",
  "verify-domain",
  "magic-link",
  "reset-password",
  "install",
  "installation",
  "settings",
  "org",
  "account",
  "backstage",
  "invites",
];

export interface CurrentTenant {
  namespace: string;
  memex: string;
}

// Parses the current URL pathname for a /<namespace>/<memex>/... shape.
// Returns null on caller-scoped routes (login, share, invite, settings, …),
// on the bare root path, and on any URL whose first segment is in the
// caller-scoped allowlist.
export function getCurrentTenant(): CurrentTenant | null {
  if (typeof window === "undefined") return null;
  return parseTenantFromPathname(window.location.pathname);
}

export function parseTenantFromPathname(pathname: string): CurrentTenant | null {
  if (!pathname || pathname === "/") return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [namespace, memex] = segments;
  if (CALLER_SCOPED_PREFIXES.includes(namespace.toLowerCase())) return null;
  // Slugs are lowercase alphanumeric + hyphen (matches server-side slug shape).
  if (!isValidSlug(namespace) || !isValidSlug(memex)) return null;
  return { namespace, memex };
}

// Returns the leading namespace slug for a `/namespace[/...]` URL. Used by the
// session-aware nav resolver to keep links inside the namespace the user is
// currently browsing (e.g. `/myorg/` → "myorg") even when no memex has been
// chosen yet. Returns null on caller-scoped routes and the bare root.
export function parseNamespaceFromPathname(pathname: string): string | null {
  if (!pathname || pathname === "/") return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 1) return null;
  const [namespace] = segments;
  if (CALLER_SCOPED_PREFIXES.includes(namespace.toLowerCase())) return null;
  if (!isValidSlug(namespace)) return null;
  return namespace;
}

function isValidSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s);
}

// Build an absolute URL at the current origin under /<namespace>/<memex>.
// Used by share-link / invite-link copy-to-clipboard and cross-tenant deep
// links. The path argument should start with "/" (e.g. "/share/abc").
export function buildTenantUrl(
  namespaceSlug: string,
  memexSlug: string,
  path: string = "/",
): string {
  const { protocol, host } = window.location;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}//${host}/${namespaceSlug}/${memexSlug}${normalizedPath === "/" ? "" : normalizedPath}`;
}

// Build a flat (caller-scoped) URL at the current origin — no tenant prefix.
// Used for /login, /share/:token landings, and the post-logout redirect.
export function buildBareDomainUrl(path: string = "/"): string {
  const { protocol, host } = window.location;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}//${host}${normalizedPath}`;
}

// Prefix the given in-tenant path with the current tenant's /<ns>/<mx> segments.
// Returns the path unchanged when no tenant context exists (caller-scoped
// routes), so call sites can hand back something safe whether or not the user
// is currently browsing a tenant.
//
// Pass an absolute path (starts with "/"). The helper returns absolute paths
// suitable for <Link to=…> and useNavigate().
export function tenantPath(path: string): string {
  const t = getCurrentTenant();
  if (!t) return path.startsWith("/") ? path : `/${path}`;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `/${t.namespace}/${t.memex}${normalized === "/" ? "" : normalized}`;
}

// Build a path under a *specific* tenant (used by MemexSwitcher when navigating
// to a different memex than the current one).
export function tenantPathFor(
  namespaceSlug: string,
  memexSlug: string,
  path: string = "/",
): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `/${namespaceSlug}/${memexSlug}${normalized === "/" ? "" : normalized}`;
}

// Build the path to a namespace's home page (the kind-aware Org / Personal
// page from doc-19 t-10). Used as the post-Org-creation redirect (per dec-2 of
// doc-19) and by the React UI router to reference the route.
export function namespaceHomePath(slug: string): string {
  return `/${slug}/`;
}

// Minimal membership shape resolveNavTo needs (a subset of the session
// membership rows).
export interface MembershipForNav {
  slug: string;
  memexSlug: string;
  kind: "personal" | "team";
}

// spec-201: resolve a tenant-relative path (e.g. "/keys") to an absolute,
// memex-scoped URL. Extracted from AppShell so non-shell surfaces (the
// Integrations AC-emitter section) can build the same deep links.
//
// Resolution order: (1) the tenant in the current path, (2) the namespace in
// the current path matched against a membership, (3) the user's personal (or
// first) membership, (4) the path unchanged when no tenant context exists.
export function resolveNavTo(
  toInTenant: string,
  pathname: string,
  memberships: MembershipForNav[] | undefined,
): string {
  const normalized = toInTenant.startsWith("/") ? toInTenant : `/${toInTenant}`;
  const suffix = normalized === "/" ? "" : normalized;

  const tenant = parseTenantFromPathname(pathname);
  if (tenant) return `/${tenant.namespace}/${tenant.memex}${suffix}`;

  const ns = parseNamespaceFromPathname(pathname);
  if (ns && memberships) {
    const m = memberships.find((row) => row.slug === ns);
    if (m) return `/${ns}/${m.memexSlug}${suffix}`;
  }

  if (memberships && memberships.length > 0) {
    const personal =
      memberships.find((row) => row.kind === "personal") ?? memberships[0];
    return `/${personal.slug}/${personal.memexSlug}${suffix}`;
  }

  return normalized;
}
