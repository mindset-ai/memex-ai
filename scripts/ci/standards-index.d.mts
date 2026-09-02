// Types for standards-index.mjs (spec-512 dec-4). See workspace-alloc.d.mts for
// why the implementation is an untyped `.mjs` and this declaration exists.

export const BEGIN: string;
export const END: string;

export interface StandardEntry {
  handle: string;
  summary: string;
}

export function renderTable(standards: StandardEntry[]): string;

/** The repositories this Memex is the system of record for (spec-544 dec-1). */
export const REPOS: string[];

/** A Standard as the live list returns it under `?type=standard&include=tags`. */
export interface LiveStandard {
  handle: string;
  title: string;
  tags?: Array<{ scope: string | null; value: string }>;
}

/** A manifest entry plus the repos it is attributed to (empty = every repo). */
export interface PlannedEntry extends StandardEntry {
  repos: string[];
}

export interface IndexPlan {
  /** Every live Standard, curated summaries preserved, sorted by handle. */
  standards: PlannedEntry[];
  /** Handles whose summary was seeded from the live title (placeholders). */
  seeded: string[];
  /** The rendered table for the requested repo — fail-open filtered. */
  table: string;
}

/** Plan the manifest and one repo's index from the LIVE Standard list.
 *  Pure: no network, no fs. Throws on a non-array or empty live list rather
 *  than generating from it (spec-544 ac-9). */
export function planIndex(input: {
  live: LiveStandard[];
  manifest: StandardEntry[];
  repo: string;
}): IndexPlan;

/** Byte offsets of every generated region. Throws on unbalanced, orphaned,
 *  out-of-order or nested markers rather than rewriting part of the file. */
export function findRegions(text: string): Array<{ start: number; end: number }>;

/** Replace the body of EVERY generated region — never only the first. */
export function applyRegions(text: string, body: string): string;
