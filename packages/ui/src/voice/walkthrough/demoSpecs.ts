// spec-211 t-2 (dec-2): resolve which demo spec to OPEN at a given walkthrough
// phase, and the route to it.
//
// The demo specs are the five frozen spec-64 copies seeded into a personal Memex
// (spec-178) — one per phase. The client already holds them from the REST board
// fetch (fetchDocs), each carrying `handle` / `status` / `isDemo`. Resolving the
// per-phase demo doc from THAT list (never an agent doc-lookup) is what keeps
// spec-178 dec-11 intact — the demo specs stay invisible to every agent surface.

import type { DocSummary } from '../../api/types';
import type { RevealPhase } from '../../hooks/useHandholdReveal';
import { tenantPath } from '../../utils/tenantUrl';

/** The demo doc revealed at `phase`: the `isDemo` doc whose status matches it.
 *  Null if no demo spec is seeded for that phase. */
export function demoSpecForPhase(
  docs: DocSummary[],
  phase: RevealPhase,
): DocSummary | null {
  return docs.find((d) => d.isDemo === true && d.status === phase) ?? null;
}

/** Detail-route path for a demo spec (the route the board card links to:
 *  `/<ns>/<mx>/specs/<handle>`). */
export function demoSpecPath(doc: DocSummary): string {
  return tenantPath(`/specs/${doc.handle}`);
}

/** Convenience: the detail path for the demo spec at `phase`, or null if absent. */
export function demoSpecPathForPhase(
  docs: DocSummary[],
  phase: RevealPhase,
): string | null {
  const doc = demoSpecForPhase(docs, phase);
  return doc ? demoSpecPath(doc) : null;
}
