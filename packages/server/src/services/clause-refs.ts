// spec-179 (dec-3): clause_refs maintenance — the write-path half of the
// standards network map's edge data.
//
// Standard-clause bodies cite other entities via the strict std-1 handle
// grammar. `syncClauseRefsTx` re-derives a clause's rows inside the SAME
// transaction as the clause write (services/clauses.ts calls it from every
// mutation), so the materialized refs can never drift from the prose they
// were parsed from. The one-time corpus backfill lives in
// drizzle/0076_add_clause_refs.sql — its regex + kind mapping MUST stay in
// lock-step with PARSE / PREFIX_TO_KIND below (same convention as 0074 ↔
// issue-handle-rewrite.ts; the lock-step test executes the migration's
// backfill section verbatim).
//
// Known, accepted gap: legacy decomposed-section preambles are backfilled once
// and NOT resynced on edit — post spec-161, standard sections are clause-first
// (preamble null) and preambles are frozen connective prose.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { clauseRefs, documents } from "../db/schema.js";

// Mirrors the backfill regex in 0076: \b(std|spec|b|doc|dec|cl)-(\d+)\b.
// `b-N` is the legacy pre-rename spec handle shape (preserved by b-105), so
// it maps to kind 'spec' exactly like spec-N.
const PARSE = /\b(std|spec|b|doc|dec|cl)-(\d+)\b/g;

const PREFIX_TO_KIND: Record<string, ClauseRefKind> = {
  std: "standard",
  spec: "spec",
  b: "spec",
  doc: "document",
  dec: "decision",
  cl: "clause",
};

// Doc-level kinds get a memex-scoped documents.handle resolution; dec-N / cl-N
// are doc-relative (ambiguous without their parent doc) so they stay null.
const DOC_LEVEL_PREFIXES = new Set(["std", "spec", "b", "doc"]);

export type ClauseRefKind = "standard" | "spec" | "document" | "decision" | "clause";

export interface ParsedHandleRef {
  kind: ClauseRefKind;
  handle: string;
  /** Whether `handle` can resolve to a documents row (std/spec/b/doc). */
  docLevel: boolean;
}

/** Parse the handle mentions out of one prose body. Deduped, order-preserving. */
export function parseHandleRefs(body: string): ParsedHandleRef[] {
  const seen = new Set<string>();
  const out: ParsedHandleRef[] = [];
  for (const m of body.matchAll(PARSE)) {
    const prefix = m[1];
    const handle = `${prefix}-${m[2]}`;
    const kind = PREFIX_TO_KIND[prefix];
    const key = `${kind}|${handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, handle, docLevel: DOC_LEVEL_PREFIXES.has(prefix) });
  }
  return out;
}

// The slice of a clause row syncClauseRefsTx needs. Matches StandardClause.
export interface ClauseForSync {
  id: string;
  memexId: string;
  docId: string;
  body: string;
  status: string;
}

// Same loose transaction-handle shape as services/clauses.ts.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Re-derive one clause's clause_refs rows inside the caller's transaction:
 * delete-and-reinsert (the row set is tiny — a clause cites a handful of
 * handles at most). A soft-deleted clause keeps zero rows. Handle resolution
 * is memex-scoped (ac-12): a handle that doesn't resolve inside the clause's
 * own memex keeps target_doc_id NULL — never a cross-memex id.
 */
export async function syncClauseRefsTx(tx: Tx, clause: ClauseForSync): Promise<void> {
  await tx.delete(clauseRefs).where(eq(clauseRefs.sourceClauseId, clause.id));
  if (clause.status === "deleted") return;

  const refs = parseHandleRefs(clause.body);
  if (refs.length === 0) return;

  const docHandles = refs.filter((r) => r.docLevel).map((r) => r.handle);
  const resolved =
    docHandles.length > 0
      ? await tx
          .select({ id: documents.id, handle: documents.handle })
          .from(documents)
          .where(and(eq(documents.memexId, clause.memexId), inArray(documents.handle, docHandles)))
      : [];
  const byHandle = new Map(resolved.map((d) => [d.handle, d.id]));

  await tx.insert(clauseRefs).values(
    refs.map((r) => ({
      memexId: clause.memexId,
      sourceClauseId: clause.id,
      sourceDocId: clause.docId,
      targetKind: r.kind,
      targetHandle: r.handle,
      targetDocId: r.docLevel ? (byHandle.get(r.handle) ?? null) : null,
    })),
  );
}
