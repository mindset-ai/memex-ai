export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// An EMBEDDED uuid token (not anchored), for finding/removing a raw id inside
// free text. Kept separate from the anchored UUID_RE so isUuid stays an
// exact-match check. The `.test()` regex is non-global (stateless); the
// `.replace()` regex is global.
const UUID_TOKEN_ANY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const UUID_TOKEN_GLOBAL = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** True when `s` contains a raw UUID token anywhere. */
export function containsUuid(s: string): boolean {
  return UUID_TOKEN_ANY.test(s);
}

/**
 * Remove any raw UUID token from free text and tidy the doubled spaces / dangling
 * separators left behind (newlines preserved — only runs of spaces collapse).
 *
 * The b-36 invariant — canonical refs in, NO raw UUIDs out — is a human-facing
 * surface rule (enforced by the authed smoke). Activity narratives REPLAY
 * immutable historical text: a row written before a narrative fix can still read
 * "created doc_member <uuid>", and forward-only fixes can't rewrite it. So the
 * display/read boundary strips defensively rather than trusting the stored value.
 */
export function stripUuids(text: string): string {
  return text
    .replace(UUID_TOKEN_GLOBAL, "")
    .replace(/ {2,}/g, " ")
    .replace(/ +—\s*$/gm, "")
    .replace(/[ \t]+$/gm, "");
}

/**
 * Parse a handle like "dec-3" or "t-1" and return the sequence number,
 * or null if the string doesn't match the given prefix.
 */
export function parseHandle(s: string, prefix: string): number | null {
  const match = s.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
  return match ? parseInt(match[1]) : null;
}
