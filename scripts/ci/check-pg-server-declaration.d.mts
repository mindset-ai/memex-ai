// Types for check-pg-server-declaration.mjs (spec-524). See workspace-alloc.d.mts
// for why the implementation is an untyped `.mjs` and this declaration exists.
//
// Every function here is pure and takes a repo root, so the vitest twin-guard can
// drive it against a temp fixture — a scan proven only against the real tree is
// indistinguishable from a scan that searches nothing.

/** The three sites that guessed a Postgres port before spec-524. */
export const GUARDED: readonly string[];

/** Documentation that must point at the declaration rather than restate it. */
export const DOC_SITES: readonly string[];

export const WORKFLOW_DIR: string;

/** Guarded sites holding a Postgres port literal, as `file:line: text`.
 *  A guarded file that has MOVED is reported rather than silently skipped:
 *  protecting nothing while reporting success is the worst outcome for a
 *  path-based guard. */
export function findPortLiterals(repoRoot: string): string[];

/** Workflow files setting the capability-probe bypass, as `file:line: text`.
 *  Comment lines are exempt — a workflow may explain why it is forbidden. */
export function findBypassInWorkflows(repoRoot: string): string[];

/** Documentation restating a local Postgres DSN, as `file:line: text`. */
export function findDsnInDocs(repoRoot: string): string[];
