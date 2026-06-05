// spec-150 t-3 (dec-1): the derived-content projection.
//
// A decomposed standard section keeps a `preamble` (its non-clause connective prose)
// plus an ordered set of clause rows. Its stored `doc_sections.content` is a DERIVED
// projection: the preamble followed by the clause bodies in position order. The whole
// transparency contract rests on this projection being byte-identical to the section's
// original content, so the embed / FTS / export / admin read paths (which all read
// `content`) see exactly the same bytes after decomposition as before.
//
// The guarantee is structural, not heuristic: a clause body is the EXACT contiguous
// source slice captured by the decomposition (services/clause-decomposition, t-6),
// including its leading separator and marker. Composition is therefore plain
// concatenation, and `compose(split(content)) === content` for ANY content regardless
// of where the clause boundaries fall. The split heuristic decides what counts as a
// clause; it can never change the bytes.
//
// Pure module — no DB, no I/O. The service layer (clause CRUD) loads a section's
// clauses and calls `composeSectionContent` to regenerate `content` on every clause
// mutation; the decomposition migration calls it to verify round-trip identity.

export interface ComposableClause {
  /** In-section ordering (dec-2: `position` resequences freely; distinct from the
   * stable `seq` identity). Composition is by ascending position. */
  position: number;
  /** The clause's verbatim source slice (includes its leading separator + marker),
   * so concatenation reproduces the original bytes exactly. */
  body: string;
}

/**
 * Compose a section's stored content from its preamble + clauses, in position order.
 * Exact concatenation: `preamble + clause bodies joined with no inserted separator`.
 *
 * A section with no clauses composes to its preamble alone (the not-decomposed case
 * keeps `content` authoritative; callers pass `content` as the preamble there).
 */
export function composeSectionContent(
  preamble: string,
  clauses: readonly ComposableClause[],
): string {
  const ordered = [...clauses].sort((a, b) => a.position - b.position);
  return preamble + ordered.map((c) => c.body).join("");
}

/** A section's content partitioned into a leading preamble and ordered clause bodies. */
export interface SectionDecomposition {
  preamble: string;
  /** Clause bodies in document order; each is the verbatim source slice (1-based
   * position is its array index + 1). */
  clauses: string[];
}

/**
 * Partition a section's markdown into a preamble + contiguous clause slices, the
 * inverse of `composeSectionContent`. A clause begins at a top-level markdown list
 * item (`- `, `* `, `+ `, or `N.` / `N)`); the preamble is everything before the
 * first one, and each clause runs from its marker line up to (not including) the
 * next marker line, so blank lines and continuation lines ride with their clause.
 *
 * BYTE-EXACT by construction: the parts are contiguous slices of the input, so
 * `composeSectionContent(split(content)) === content` for ANY content. The heuristic
 * only decides WHERE the boundaries fall; it can never change the bytes. A section
 * with no list items returns the whole content as preamble and zero clauses (it is
 * left effectively non-decomposed).
 */
export function splitSectionIntoClauses(content: string): SectionDecomposition {
  // Match each line INCLUDING its trailing newline (and a final newline-less line),
  // so re-joining is exact.
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const isClauseStart = (line: string): boolean => /^\s*([-*+]|\d+[.)])\s+/.test(line);

  const firstIdx = lines.findIndex(isClauseStart);
  if (firstIdx === -1) {
    return { preamble: content, clauses: [] };
  }

  const preamble = lines.slice(0, firstIdx).join("");
  const clauses: string[] = [];
  let current = "";
  for (let i = firstIdx; i < lines.length; i++) {
    if (isClauseStart(lines[i]) && current !== "") {
      clauses.push(current);
      current = "";
    }
    current += lines[i];
  }
  if (current !== "") clauses.push(current);
  return { preamble, clauses };
}
