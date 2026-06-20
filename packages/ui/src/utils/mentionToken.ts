// spec-320 (dec-4): the @-mention typeahead's text model, kept pure so the
// detection rules are unit-testable in isolation from React.
//
// An "active mention token" is the `@…` the caret is currently inside while the
// author types. The composer shows the member typeahead exactly when one exists,
// and filters it by the token's query. `@` opens it (empty query → full roster);
// a whitespace ends it.

export interface MentionToken {
  /** The text after `@` up to the caret (the substring to search members by). */
  query: string;
  /** Index of the `@` in the source text — where a replacement begins. */
  start: number;
}

// Return the active mention token if the caret sits inside an `@…` run, else null.
// The `@` must be at the start of the text or preceded by whitespace (so an email
// like `a@b.com` mid-word never triggers the typeahead), and the run from `@` to
// the caret must contain no whitespace or second `@`.
export function activeMentionToken(text: string, caret: number): MentionToken | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") {
      const prev = i > 0 ? text[i - 1]! : " ";
      if (i === 0 || /\s/.test(prev)) {
        const query = text.slice(i + 1, caret);
        if (/^[^\s@]*$/.test(query)) return { query, start: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null; // whitespace before any `@` ⇒ not in a token
    i--;
  }
  return null;
}

// Replace the active `@token` (from `start` to `caret`) with `@label ` and report
// the new caret position (just after the inserted trailing space).
export function replaceMentionToken(
  text: string,
  start: number,
  caret: number,
  label: string,
): { text: string; caret: number } {
  const inserted = `@${label} `;
  const next = text.slice(0, start) + inserted + text.slice(caret);
  return { text: next, caret: start + inserted.length };
}
