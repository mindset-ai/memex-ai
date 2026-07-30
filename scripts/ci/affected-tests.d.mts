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
