// spec-372 issues 13–16 — the onboarding SDD-arc prompts (decisions / acceptance criteria /
// specs-match-reality / agents-build) reference the user's REAL spec number, not "this spec".
//
// Rule: count the non-archived specs in the user's personal Memex. If exactly one
// spec exists — the one created by the "Create your first spec" step — inject its
// handle; otherwise fall back to a fill-in placeholder.
import type { DocSummary } from '../../api/types';

export const SPEC_TOKEN_PLACEHOLDER = '<insert a spec number of one of your specs>';

export function resolveSpecToken(docs: DocSummary[]): string {
  // spec-409 removed the pause feature, so there is no `pausedAt` to exclude.
  const real = docs.filter((d) => !d.archivedAt);
  return real.length === 1 ? real[0].handle : SPEC_TOKEN_PLACEHOLDER;
}
