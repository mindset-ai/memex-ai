// spec-566 dec-2 — one rendering decision for the superseded count.
//
// A superseded criterion is EXCLUDED from the coverage maths and COUNTED BESIDE
// it. The percentage keeps meaning "the live set is verified"; the count beside
// it is what makes the badge falsifiable. `10 of 10 · 1 superseded` — never a
// bare `10 of 10`, and never the 91% that would follow from leaving a retired
// criterion in the denominator.
//
// WHY THIS IS SHARED AND NOT A TEMPLATE. Nine surfaces render AC coverage (the
// MCP/agent header plus eight React components) and no two of them render the
// same sentence: one is a markdown headline, one a card chip, one an aria-label.
// Forcing one template across all nine would fight every caller. What IS one
// decision is the WORDING of the count and the rule that zero renders nothing —
// so that is what lives here, and each surface composes it into its own shape.
//
// Pure: no DB, no clock, no framework. Both packages already import
// `@memex/shared`, which is what makes "one decision" literally true rather
// than nine copies that agree today.

/**
 * The only AC status that counts toward a live commitment.
 *
 * `proposed` and `rejected` criteria are excluded from coverage too, but
 * silently — they were never commitments, so there is nothing to account for.
 * Supersession is different: the criterion WAS a commitment and was retired,
 * which is exactly the move this Spec exists to keep visible.
 */
export function isLiveAcStatus(status: string | null | undefined): boolean {
  return status === "active";
}

/**
 * The count's wording, or `null` when there is nothing to say.
 *
 * Returning `null` rather than an empty string is deliberate: a JSX caller can
 * write `{label && <span>{label}</span>}` and render no element at all, so an
 * empty badge can never appear. Callers building a string want
 * `supersededSuffix` instead.
 */
export function supersededCountLabel(count: number): string | null {
  return count > 0 ? `${count} superseded` : null;
}

/**
 * The count as a ` · N superseded` tail, for a caller assembling one line of
 * text (the MCP/agent coverage header, an aria-label). Empty when the count is
 * zero, so it concatenates unconditionally.
 */
export function supersededSuffix(count: number): string {
  const label = supersededCountLabel(count);
  return label ? ` · ${label}` : "";
}
