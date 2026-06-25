// spec-380 dec-1 (DRY consolidation; audit spec-345 dry-5) — the ONE canonical
// docType → ref-path-segment mapping. This IS the std-10 §2 ref grammar
// (`doc-type ∈ {specs, docs, standards, execution-plans}`), so it lives in
// @memex/shared alongside the rest of the ref-grammar knowledge (toInitPromptRef,
// BASE_SCAFFOLD) rather than being copy-pasted per call site. It was byte-identical
// in packages/ui/src/utils/taskInitPrompt.ts and specInitPrompt.ts; both now import
// from here.
//
// NOT portable surface (std-22): this maps Memex's OWN doc-types to Memex's OWN ref
// segments — internal addressing logic, not text/tooling applied to a user's codebase.
//
// Boundary note (spec-374 carve-out): reached only by UI init-prompt files; it is NOT
// imported by db/schema.ts or types/roles.ts, so the standalone @mindset-ai/db-schema
// bundle (which only sees drizzle-orm) is unaffected.

/**
 * Map a docType (as stored in the database) to the canonical ref path segment.
 * Specs live under `specs/spec-N`; free-form docs and execution-plans under
 * `docs/doc-N` / `execution-plans/doc-N`; standards under `standards/std-N`.
 */
export function docTypePath(docType: string): string {
  switch (docType) {
    case 'spec':
      return 'specs';
    case 'standard':
      return 'standards';
    case 'execution_plan':
      return 'execution-plans';
    default:
      return 'docs';
  }
}
