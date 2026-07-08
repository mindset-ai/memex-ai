// spec-473 UI: an inline content count in a sub-tab label — noun + "(n)"
// ("Decisions (4)", "AC (1)"), which reads more clearly than a bare leading
// number. Falls back to the bare noun when the count is zero so empty tabs read
// cleanly ("Decisions & ACs", or a mixed "Decisions & ACs (6)").
export function countLabel(n: number, singular: string, plural: string): string {
  return n > 0 ? `${n === 1 ? singular : plural} (${n})` : plural;
}
