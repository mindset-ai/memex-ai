// spec-372 issues 13–16 — the onboarding SDD-arc prompts (decisions / acceptance criteria /
// specs-match-reality / agents-build) reference the user's REAL spec number, not "this spec".
//
// Rule: count the specs in the user's personal Memex EXCLUDING the demo spec(s) that spec-178
// seeds into every personal Memex (isDemo) and any archived/paused ones. If exactly one real
// spec exists — the one created by the "Create your first spec" step — inject its handle;
// otherwise fall back to a fill-in placeholder.
import type { DocSummary } from '../../api/types';

export const SPEC_TOKEN_PLACEHOLDER = '<insert a spec number of one of your specs>';

export function resolveSpecToken(docs: DocSummary[]): string {
  const real = docs.filter((d) => !d.isDemo && !d.archivedAt && !d.pausedAt);
  return real.length === 1 ? real[0].handle : SPEC_TOKEN_PLACEHOLDER;
}
