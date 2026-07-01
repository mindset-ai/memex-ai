// The RLS-gated tenant tables — the single source of truth for "which tables
// enforce per-tenant isolation" (spec-440 dec-2 / ac-11).
//
// Each table here carries a `<table>_memex_isolation` policy (FOR ALL, USING +
// WITH CHECK on `app.memex_id = memex_id`) created by the migrations (0081,
// 0087, 0092, 0100, 0114, 0115). A write to any of these tables only satisfies
// RLS when `app.memex_id` is set in the session — supplied by the rlsClient
// proxy from the `memexContext` ALS store (connection.ts). Under the non-owner
// runtime role `memex_app` (prod), a context-less write is REJECTED; under the
// owner role (dev/test/migrations) it is bypassed (std-36: ENABLE, NO FORCE).
//
// This list is HAND-MAINTAINED but drift-proofed: `rls-tables.pg-policy-parity`
// asserts it exactly equals `SELECT tablename FROM pg_policies WHERE policyname
// LIKE '%_memex_isolation'` against the live schema, so a new gated table (or a
// removed policy) that isn't reflected here fails CI. When you add/remove a
// `*_memex_isolation` policy in a migration, update this set in the same change.
//
// NOTE the deliberate EXCLUSION of `memex_emission_keys`: it was given the
// policy in 0081 but had it DROPPED in 0087_emission_keys_rls_exclusion.sql — it
// is an identity-establishment table read BEFORE any tenant context exists, so
// it must stay RLS-free (pinned by __regression__/emission-key-contextless-verify).
export const RLS_TENANT_TABLES: ReadonlySet<string> = new Set([
  "acs",
  "clause_refs",
  "comment_mentions",
  "decision_facet_ballots",
  "decisions",
  "doc_assignees",
  "doc_comments",
  "doc_members",
  "document_tags",
  "documents",
  "facet_routing_log",
  "issues",
  "presence",
  "qa_report_views",
  "repos",
  "standard_clause_facets",
  "standard_clauses",
  "tags",
  "task_facet_ballots",
  "tasks",
]);

/** True iff `table` is one of the RLS-gated tenant tables (case-insensitive). */
export function isRlsGatedTable(table: string): boolean {
  return RLS_TENANT_TABLES.has(table.toLowerCase());
}
