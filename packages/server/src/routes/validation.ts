// Tiny request-validation helpers for route handlers. Each throws ValidationError
// (mapped to HTTP 400 by the error-handler middleware) so route bodies stay flat:
//
//   const email = requireString(body?.email, "email");
//
// instead of:
//
//   if (typeof email !== "string" || !email) {
//     return c.json({ error: "email is required" }, 400);
//   }
//
// We deliberately do NOT trim — `password` and similar fields must preserve user input
// verbatim. Pass `{ trim: true }` for fields where trimming is desired.

import { ValidationError } from "../types/errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireString(
  value: unknown,
  fieldName: string,
  opts: { trim?: boolean; maxLength?: number; message?: string } = {}
): string {
  if (typeof value !== "string" || !value || (opts.trim && !value.trim())) {
    throw new ValidationError(opts.message ?? `${fieldName} is required`);
  }
  const out = opts.trim ? value.trim() : value;
  if (opts.maxLength && out.length > opts.maxLength) {
    throw new ValidationError(`${fieldName} must be ${opts.maxLength} characters or fewer`);
  }
  return out;
}

// Like requireString but ACCEPTS the empty string — the value must merely be of
// type `string`. Some endpoints legitimately allow an empty body field (e.g. a
// doc title or section content can be cleared to ""), where requireString's
// reject-empty rule would be wrong. The `message` overrides the default error
// text so callers can preserve a bespoke wording verbatim.
export function requireStringType(
  value: unknown,
  fieldName: string,
  opts: { message?: string } = {}
): string {
  if (typeof value !== "string") {
    throw new ValidationError(opts.message ?? `${fieldName} must be a string`);
  }
  return value;
}

// Requires an array whose every element is a string. Throws ValidationError on
// any other shape (non-array, or an array containing a non-string). The
// `message` overrides the default error text to preserve a caller's wording.
export function requireStringArray(
  value: unknown,
  fieldName: string,
  opts: { message?: string } = {}
): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ValidationError(opts.message ?? `${fieldName} must be an array of strings`);
  }
  return value as string[];
}

export function requireUuid(value: unknown, fieldName: string): string {
  const str = requireString(value, fieldName);
  if (!UUID_RE.test(str)) {
    throw new ValidationError(`${fieldName} must be a valid UUID`);
  }
  return str;
}

export function requireEmail(value: unknown, fieldName = "email"): string {
  const str = requireString(value, fieldName, { trim: true });
  if (!EMAIL_RE.test(str)) {
    throw new ValidationError(`${fieldName} must be a valid email address`);
  }
  return str.toLowerCase();
}

// Parses JSON body, throwing ValidationError on bad JSON. Used as:
//   const body = await readJsonBody(c);
//   const email = requireString(body.email, "email");
export async function readJsonBody<T = Record<string, unknown>>(c: {
  req: { json: () => Promise<unknown> };
}): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

// Parses JSON body, returning `fallback` (default null) on malformed JSON
// INSTEAD of throwing — the opposite policy to readJsonBody. This is for
// endpoints that intentionally let a bad/empty body fall through to a
// field-specific validation message (`c.req.json().catch(() => null)`), so the
// caller's own field check, not a generic JSON error, decides the response.
export async function parseJsonBodyOrNull<T = Record<string, unknown>>(
  c: { req: { json: () => Promise<unknown> } },
  fallback: T | null = null
): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return fallback;
  }
}
