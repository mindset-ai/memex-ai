// Decode HTML entities in PLAIN-TEXT fields (titles/labels).
//
// Why this exists: some legacy section-creation paths stored section titles
// HTML-entity-encoded — e.g. "Architecture & Security" was persisted as
// "Architecture &amp; Security". Titles render as plain React text (not through a
// markdown/HTML pipeline), so the literal "&amp;" shows on screen. Current write
// paths store titles raw, so this is bounded legacy data, but it surfaces wherever a
// dirty title is displayed. Decoding plain-text titles at the data boundary fixes the
// display everywhere without a data migration, and is safe: a title should never carry
// an intentional HTML entity, and a bare "&" (no trailing ';') is left untouched.
//
// Pure + dependency-free (no DOM), so it runs the same in the browser, jsdom tests,
// and any SSR path. Decodes the named entities a title realistically carries plus
// decimal/hex numeric refs. Single-pass (we never produced double-encoded titles).

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Matches a well-formed entity: &name; | &#123; | &#x1F600;
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeHtmlEntities(input: string): string {
  // Fast path: nothing that could be an entity.
  if (!input || input.indexOf('&') === -1) return input;
  return input.replace(ENTITY, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const decoded = NAMED[body.toLowerCase()];
    return decoded ?? match; // unknown entity → leave verbatim
  });
}
