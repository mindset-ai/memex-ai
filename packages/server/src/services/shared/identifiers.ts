export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Parse a handle like "dec-3" or "t-1" and return the sequence number,
 * or null if the string doesn't match the given prefix.
 */
export function parseHandle(s: string, prefix: string): number | null {
  const match = s.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
  return match ? parseInt(match[1]) : null;
}
