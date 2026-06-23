// Timestamp normalisation helpers shared by the retrieval + ranking modules
// (spec-363 sol-7: god-module split). Moved verbatim from memex-search.ts.

// spec-285: normalise a timestamptz coming back from the driver (Date or ISO
// string depending on the column path) to a stable ISO-8601 string for the hit
// shape. null/invalid → null so the formatter and REST JSON degrade gracefully.
export function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// spec-285: epoch millis for comparing two timestamptz values; missing/invalid
// sorts oldest so a real timestamp always wins the "latest section" pick.
export function toMillis(value: string | Date | null | undefined): number {
  if (value == null) return -Infinity;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? -Infinity : t;
}
