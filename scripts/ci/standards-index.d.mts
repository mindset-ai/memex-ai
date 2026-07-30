// Types for standards-index.mjs (spec-512 dec-4). See workspace-alloc.d.mts for
// why the implementation is an untyped `.mjs` and this declaration exists.

export const BEGIN: string;
export const END: string;

export interface StandardEntry {
  handle: string;
  summary: string;
}

export function renderTable(standards: StandardEntry[]): string;

/** Byte offsets of every generated region. Throws on unbalanced, orphaned,
 *  out-of-order or nested markers rather than rewriting part of the file. */
export function findRegions(text: string): Array<{ start: number; end: number }>;

/** Replace the body of EVERY generated region — never only the first. */
export function applyRegions(text: string, body: string): string;
