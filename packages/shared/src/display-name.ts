// spec-259 dec-4 — conservative display-name capitalization for presentation.
//
// Author/actor names render verbatim today — lowercase or email-derived (e.g.
// "barrie hadfield", "barrie@mindset.ai"). This helper title-cases them for DISPLAY
// only. It is applied at every render site that emits a name: the spec-122:dec-8 WHO
// resolver (who-resolver.ts) and — because search resolves WHO inline in SQL and
// bypasses that resolver — the search formatter (memex-search.ts formatHitByline +
// per-section lines).
//
// It NEVER mutates stored author_name / actor_name: std-32 makes those the immutable
// audit record, stamped at write so a rename can't rewrite history. Capitalization is
// strictly a read/render transform.
//
// The algorithm is deliberately conservative — it uppercases ONLY a leading lowercase
// letter of each whitespace-separated token and never touches interior casing, so
// real names survive intact:
//   "barrie hadfield" → "Barrie Hadfield"
//   "McDonald"        → "McDonald"   (interior capital preserved)
//   "o'brien"         → "O'brien"    (apostrophe is not a token boundary)
//   "DeShawn"         → "DeShawn"    (already-correct interior capital preserved)
// and two classes are returned untouched:
//   - any value containing "@" (the user.name ?? user.email fallback — emails must
//     not be title-cased: "barrie@…" → "Barrie@…" is wrong)
//   - known agent labels (e.g. "Memex agent") — not people.

const AGENT_LABELS = new Set(['memex agent', 'memex ai', 'memex']);

/**
 * Title-case a display name for presentation, preserving interior casing and leaving
 * email-derived fallbacks and agent labels untouched. Render-layer only — never feed
 * the result back into a stored column.
 */
export function capitalizeDisplayName(raw: string | null | undefined): string {
  if (raw == null) return '';
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  if (trimmed.includes('@')) return raw; // email fallback — leave verbatim
  if (AGENT_LABELS.has(trimmed.toLowerCase())) return raw; // agent label — not a person

  // Uppercase only a leading lowercase letter of each whitespace-delimited token.
  // Interior characters and the original whitespace are preserved exactly.
  return raw.replace(/(^|\s)([a-z])/g, (_match, boundary: string, ch: string) => boundary + ch.toUpperCase());
}
