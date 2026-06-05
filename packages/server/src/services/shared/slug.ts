// Namespace slug allocation rules (std-3 of doc-15).
//
// One global slug pool shared by user + org namespaces. Format, reserved list,
// and the rename cooldown are all centralised here so the route layer, the DB
// CHECK constraint, and the t-1 e2e spec stay in sync.

import { eq, lt } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { namespaces, namespaceSlugReservations } from "../../db/schema.js";

// std-3 / dec-11 — small, stable list of app-utility paths only. Marketing
// terms (pricing, about, blog, …) deliberately NOT reserved because marketing
// lives on www.memex.ai.
export const RESERVED_SLUGS = new Set([
  "login",
  "signup",
  "install",
  "install.sh",
  "install.ps1",
  "api",
  "auth",
  "health",
  "share",
  "settings",
  "me",
  "mcp",
  "admin",
  "account",
  "app",
  "docs",
  "support",
  "help",
  "memex",
]);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export type SlugFormatError =
  | "empty"
  | "too_long"
  | "invalid_chars"
  | "reserved";

export interface SlugValidationResult {
  valid: boolean;
  error?: SlugFormatError;
}

// Pure format check — no DB lookup. Use this in the input layer to fail fast.
export function validateSlugFormat(input: string): SlugValidationResult {
  const slug = input.trim().toLowerCase();
  if (slug.length === 0) return { valid: false, error: "empty" };
  if (slug.length > 39) return { valid: false, error: "too_long" };
  if (!SLUG_RE.test(slug)) return { valid: false, error: "invalid_chars" };
  if (RESERVED_SLUGS.has(slug)) return { valid: false, error: "reserved" };
  return { valid: true };
}

// True when the slug is free in the active namespace pool AND not held in the
// post-rename reservation table. Use this BEFORE any insert that targets
// `namespaces.slug` to give callers a clean structured error rather than a
// raw 23505.
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const normalized = slug.trim().toLowerCase();
  const active = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, normalized),
  });
  if (active) return false;
  const now = new Date();
  const reserved = await db.query.namespaceSlugReservations.findFirst({
    where: eq(namespaceSlugReservations.slug, normalized),
  });
  if (reserved && reserved.reservedUntil > now) return false;
  return true;
}

// Auto-derive a user-namespace slug from an email local-part (std-3): lowercased,
// non-[a-z0-9] chars replaced with `-`, runs of `-` collapsed, leading/trailing
// `-` trimmed, capped at 39 chars. Falls back to `user-<short>` if the result
// would be empty / reserved / shape-invalid.
export function slugFromEmail(email: string, fallbackKey: string): string {
  const localPart = email.split("@")[0] ?? "";
  let s = localPart.toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  s = s.slice(0, 39);
  const check = validateSlugFormat(s);
  if (check.valid) return s;
  return `user-${fallbackKey.slice(0, 8)}`;
}

// Append `-2`, `-3`, ... when the candidate is already in use. Caller passes a
// pre-validated base slug; resolveSlugCollision returns the first slug that
// passes isSlugAvailable. Internal-only helper used by the migration / signup.
export async function resolveSlugCollision(base: string): Promise<string> {
  let candidate = base;
  let attempt = 1;
  while (!(await isSlugAvailable(candidate))) {
    attempt += 1;
    const suffix = `-${attempt}`;
    const head = base.slice(0, 39 - suffix.length);
    candidate = `${head}${suffix}`;
  }
  return candidate;
}

// Cleanup helper: removes reservation rows whose `reserved_until` has passed.
// Called from a daily cron / on slug-rename. Cheap — uses the index on
// reserved_until.
export async function expireSlugReservations(): Promise<number> {
  const now = new Date();
  const result = await db
    .delete(namespaceSlugReservations)
    .where(lt(namespaceSlugReservations.reservedUntil, now))
    .returning({ slug: namespaceSlugReservations.slug });
  return result.length;
}
