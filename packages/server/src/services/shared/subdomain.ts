// Shared slug validation rules used by the org-creation flow. Format mirrors the
// DB-layer CHECK constraint. The "subdomain" name is a leftover from when tenants
// lived on subdomains (pre std-2); today these are path segments, but the
// validation rules (format, reserved words) are unchanged so the symbol still
// applies. Renaming is out of scope here.

// Reserved per dec-6. Cannot be used as a tenant slug — they collide with
// system paths or marketing hosts. `mcp` is reserved defensively in case a
// future host mapping uses it.
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "docs",
  "support",
  "status",
  "blog",
  "mcp",
]);

// Reserved prefixes. `personal-` is the internal sentinel for personal-namespace
// slugs; blocking the prefix prevents collisions with system-generated values.
const RESERVED_PREFIXES = ["personal-"];

export type SubdomainFormatError =
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "reserved";

export interface SubdomainValidationResult {
  valid: boolean;
  error?: SubdomainFormatError;
}

const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

// Format rules: 3-63 chars, lowercase alphanumeric + hyphens, can't start/end with hyphen.
// Mirrors the DB-layer accounts_subdomain_format CHECK constraint and the signup spec.
export function validateSubdomainFormat(input: string): SubdomainValidationResult {
  const sub = input.trim().toLowerCase();

  if (sub.length < 3) return { valid: false, error: "too_short" };
  if (sub.length > 63) return { valid: false, error: "too_long" };
  if (!SUBDOMAIN_REGEX.test(sub)) return { valid: false, error: "invalid_chars" };
  if (RESERVED_SUBDOMAINS.has(sub)) return { valid: false, error: "reserved" };
  if (RESERVED_PREFIXES.some((p) => sub.startsWith(p))) return { valid: false, error: "reserved" };

  return { valid: true };
}
