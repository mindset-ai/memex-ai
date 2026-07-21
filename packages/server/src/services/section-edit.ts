// spec-503: the pure literal-edit engine behind the edit_section tool.
// Literal string semantics only — the ambiguity remedy ("widen oldText until
// unique") depends on matching being exact, so neither regex interpretation
// nor String.replace's $-pattern substitution may ever apply here (dec-1).
// The engine returns a discriminated result and never throws; the tool
// handler owns error wording (it knows the section ref the messages cite).

export type SectionEditResult =
  | { kind: "invalid"; reason: "empty-old" | "same-text" }
  | { kind: "zero" }
  | { kind: "ambiguous"; count: number }
  | { kind: "ok"; content: string; count: number };

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply one literal oldText → newText edit to `content`.
 *
 * - `replaceAll: false` requires exactly one occurrence; more is `ambiguous`
 *   (the caller reports the count and the two remedies), none is `zero`.
 * - `replaceAll: true` replaces every non-overlapping occurrence.
 *
 * Replacement is built by slicing/joining — never String.replace with a
 * string pattern — so `$&`-style sequences in newText stay verbatim.
 */
export function applyLiteralEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): SectionEditResult {
  if (oldText.length === 0) {
    return { kind: "invalid", reason: "empty-old" };
  }
  if (oldText === newText) {
    return { kind: "invalid", reason: "same-text" };
  }

  const count = countOccurrences(content, oldText);
  if (count === 0) {
    return { kind: "zero" };
  }
  if (count > 1 && !replaceAll) {
    return { kind: "ambiguous", count };
  }

  if (replaceAll) {
    return { kind: "ok", content: content.split(oldText).join(newText), count };
  }
  const index = content.indexOf(oldText);
  const next =
    content.slice(0, index) + newText + content.slice(index + oldText.length);
  return { kind: "ok", content: next, count: 1 };
}
