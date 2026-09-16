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

/**
 * spec-566 dec-7 — the override count.
 *
 * The done-gate refuses to close a Spec holding a criterion whose rewrite nobody
 * accepted, and a human may proceed anyway on the record. dec-7 keeps that
 * escape from becoming the normal path with one device and one only: the
 * overrides are COUNTED AND SHOWN. "An override nobody can see becomes the
 * normal path; an override that appears next to the badge does not."
 */
export function overrideCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} gate override${count === 1 ? "" : "s"}`;
}

/**
 * The numbers that ride BESIDE a coverage figure, never inside it.
 *
 * One function rather than one per count, because t-5's task said it plainly —
 * "one rendering decision, three numbers" — and because the alternative is
 * editing nine surfaces again for every new number. `reopens` (t-8) lands here
 * without any of them changing.
 *
 * Order is fixed and meaningful: what was retired, then what was waved through.
 * Zeros are omitted, so a Spec with a clean history renders exactly as it did
 * before any of this existed.
 */
export interface CoverageAnnotations {
  superseded?: number;
  overrides?: number;
  reopens?: number;
}

export function coverageAnnotationLabels(a: CoverageAnnotations): string[] {
  const out: string[] = [];
  const superseded = supersededCountLabel(a.superseded ?? 0);
  if (superseded) out.push(superseded);
  const overrides = overrideCountLabel(a.overrides ?? 0);
  if (overrides) out.push(overrides);
  const reopens = reopenCountLabel(a.reopens ?? 0);
  if (reopens) out.push(reopens);
  return out;
}

/** The same, as a ` · a · b` tail for a caller assembling one line of text. */
export function coverageAnnotationSuffix(a: CoverageAnnotations): string {
  const labels = coverageAnnotationLabels(a);
  return labels.length ? ` · ${labels.join(" · ")}` : "";
}

/**
 * spec-566 dec-9 — reopening a closed Spec, counted on the same terms.
 *
 * Defined here with its siblings so t-8 wires data to an existing renderer
 * instead of adding a third vocabulary. Until t-8 lands, every caller passes 0
 * and this renders nothing.
 */
export function reopenCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} reopen${count === 1 ? "" : "s"}`;
}
