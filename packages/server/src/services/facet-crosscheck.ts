// spec-340 t-8 — the deterministic path→facet cross-check + cargo-cult integrity
// metric (dec-1).
//
// Pure and LLM-free (no model, no server inference — consistent with running
// Memex free server-side). Given the touched file paths and a task's ballot, it
// maps paths to the facets they obviously imply and flags any facet the diff
// implies but the ballot marked false — the cargo-cult signal. The mismatch RATE
// is the integrity metric.
//
// SCOPE (D7): the signatures cover only the WELL-KNOWN default facets that have an
// unambiguous, language-agnostic path signature. A custom org facet has no
// product-level path signature, so the cross-check is a PARTIAL backstop — it can
// confirm a contradiction, never prove a ballot complete. The touched paths must
// be supplied by the caller (the MCP server can't see the working tree); a
// determined agent can still under-report, which the rate makes visible over time.

export interface PathSignature {
  facetKey: string;
  test: (path: string) => boolean;
}

// Conservative, unambiguous signatures only — better to miss an implication than
// to fire a false contradiction the agent then learns to ignore.
export const PATH_SIGNATURES: readonly PathSignature[] = [
  { facetKey: "db-migrations", test: (p) => /(^|\/)(migrations?|drizzle)\//i.test(p) || /\.sql$/i.test(p) },
  {
    facetKey: "e2e-testing",
    test: (p) => /(^|\/)e2e\//i.test(p) || /\.e2e\./i.test(p) || /(playwright|cypress|cucumber)/i.test(p) || /\.feature$/i.test(p),
  },
  { facetKey: "test-coverage", test: (p) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)__tests__\//i.test(p) },
  { facetKey: "ci-pr-process", test: (p) => /(^|\/)\.github\/workflows\//i.test(p) || /(^|\/)\.gitlab-ci\.yml$/i.test(p) },
  { facetKey: "documentation", test: (p) => /\.(md|mdx)$/i.test(p) || /(^|\/)(README|CHANGELOG|RUNBOOK)/i.test(p) },
  {
    facetKey: "dependencies",
    test: (p) => /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|go\.mod|Cargo\.toml|Gemfile)$/i.test(p),
  },
];

/** The facets a set of touched paths obviously implies (default facets only). */
export function facetsImpliedByPaths(paths: string[]): string[] {
  const hits = new Set<string>();
  for (const p of paths) {
    for (const sig of PATH_SIGNATURES) {
      if (sig.test(p)) hits.add(sig.facetKey);
    }
  }
  return [...hits].sort();
}

export interface CrossCheckResult {
  /** Facets the diff's paths imply (default-facet signatures only). */
  impliedFacets: string[];
  /** Implied facets the ballot did NOT mark true — the cargo-cult contradictions. */
  mismatches: string[];
  /** mismatches / impliedFacets — the integrity metric. 0 when nothing is implied. */
  mismatchRate: number;
}

/**
 * Cross-check a ballot against the touched paths. A mismatch is a facet the diff
 * implies (e.g. a migration file) that the ballot marked false/absent (e.g.
 * db-migrations: false) — the deterministic challenge to a suspect verdict.
 */
export function crossCheckBallot(paths: string[], ballotVerdict: Record<string, boolean>): CrossCheckResult {
  const impliedFacets = facetsImpliedByPaths(paths);
  const mismatches = impliedFacets.filter((k) => ballotVerdict[k] !== true);
  return {
    impliedFacets,
    mismatches,
    mismatchRate: impliedFacets.length === 0 ? 0 : mismatches.length / impliedFacets.length,
  };
}
