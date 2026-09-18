// Types for affected-tests.mjs (spec-512 ac-4). See workspace-alloc.d.mts for why
// the implementation is an untyped `.mjs` and this declaration exists.

export interface Rule {
  test: RegExp;
  /** true ⇒ this path is broad enough that narrowing would be a lie. */
  full?: boolean;
  cmds?: string[];
  /** Stated so the mapper's output can be audited, not just trusted. */
  why: string;
}

export const RULES: Rule[];

export interface Plan {
  /** true ⇒ run the full matrix. ALWAYS true when any path is unrecognised. */
  full: boolean;
  reason: string;
  /** Never empty when `full` is true. */
  commands: string[];
  unmatched: string[];
  matched: Array<{ file: string; why: string }>;
}

/** Map changed paths to a test plan. An unrecognised path widens to the full
 *  matrix — it must never narrow to nothing. */
export function planFor(files: string[] | null | undefined): Plan;

/** True when git can resolve `ref`. The default probe behind `resolveBase`. */
export function remoteRefExists(ref: string): boolean;

/** The ref to diff against. Upgrades a bare branch name to its remote-tracking
 *  ref (`develop` → `origin/develop`), because the local one is stale in every
 *  worktree; passes an already-qualified ref through; falls back to the bare
 *  name when no remote-tracking ref exists — a CI checkout usually has none
 *  (spec-512 issue-7). `refExists` is injectable so both branches are testable
 *  without depending on the ambient checkout. */
export function resolveBase(
  name: string,
  refExists?: (ref: string) => boolean,
): string;
