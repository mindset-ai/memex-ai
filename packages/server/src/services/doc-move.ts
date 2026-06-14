import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";

// Retained for backward compatibility with existing importers. The cross-tenant
// authorization failure is now raised inside the move_doc() DB function as
// SQLSTATE 'MX002' and surfaced as a 404 per std-7 (unauthorized → 404, never
// 403) — see moveDoc()'s catch below. No code path throws this anymore.
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface MoveDocResult {
  docId: string;
  fromMemexId: string;
  toMemexId: string;
  newHandle: string;
  // Counts of dep rows deleted because they straddled two memexes after the move.
  removedDecisionDeps: number;
  removedTaskDeps: number;
  // Count of share tokens revoked on move.
  revokedShareTokens: number;
}

interface MoveDocRow {
  new_handle: string;
  revoked_share_tokens: number;
  removed_decision_deps: number;
  removed_task_deps: number;
}

// Moves a Spec from one Memex to another, whole (spec-293 dec-2/dec-3): the doc
// and every doc-scoped artifact (sections, all comments, decisions, tasks, ACs,
// test events, issues, members, assignees, tags, conversations, clause refs)
// travel together. The doc's UUID is preserved; its handle is re-minted in the
// target.
//
// The row-touching work lives in the SECURITY DEFINER `move_doc` DB function
// (migration 0094): the move re-points memex_id ACROSS the RLS tenant wall, which
// the runtime `memex_app` role cannot do directly (the memex_isolation WITH CHECK
// rejects it — the prod-only 500 this Spec fixes). The function executes as the
// table owner, so its writes bypass RLS for this one sanctioned, audited op;
// `memex_app` holds only EXECUTE on it (std-36, dec-1). This wrapper keeps the
// request-side concerns: validation, attribution (RequestCtx → mutate), and the
// cross-tenant bus emission on BOTH memexes.
export async function moveDoc(
  fromMemexId: string,
  docId: string,
  toMemexId: string,
  ctx: RequestCtx,
): Promise<Mutated<MoveDocResult>> {
  if (fromMemexId === toMemexId) {
    throw new ValidationError("Source and target memex must differ");
  }
  const userId = ctx.actorUserId;
  if (!userId) {
    // A move is an authorization-bearing operation; we must know WHO is moving.
    throw new ValidationError("A resolved user is required to move a Spec");
  }

  // Cross-tenant emit: notify BOTH the source and target memex so list views in
  // either tenant refetch (dec-2 of the reactivity contract). mutate() runs fn
  // once and, on success, emits one 'document updated' event per key, now carrying
  // the channel + actor from ctx (spec-293 dec-5 / std-32).
  return mutate(
    ctx,
    [
      { memexId: fromMemexId, docId, entity: "document", action: "updated" },
      { memexId: toMemexId, docId, entity: "document", action: "updated" },
    ],
    async () => {
      let rows: MoveDocRow[];
      try {
        rows = (await db.execute(sql`
          SELECT new_handle, revoked_share_tokens, removed_decision_deps, removed_task_deps
            FROM move_doc(${docId}::uuid, ${fromMemexId}::uuid, ${toMemexId}::uuid, ${userId}::uuid)
        `)) as unknown as MoveDocRow[];
      } catch (err) {
        // Translate the function's domain SQLSTATEs into HTTP-shaped errors.
        // Drizzle wraps driver errors (DrizzleQueryError) with the PostgresError
        // on `.cause`, so check both the error and its cause for the SQLSTATE.
        const code =
          (err as { code?: string } | null)?.code ??
          ((err as { cause?: { code?: string } } | null)?.cause?.code);
        if (code === "MX001" || code === "MX002") {
          // Doc not found in source, or caller not authorized in source/target.
          // std-7: unauthorized → 404, never 403 (don't leak existence).
          throw new NotFoundError("Document not found");
        }
        if (code === "MX003") {
          throw new ValidationError("Source and target memex must differ");
        }
        throw err;
      }

      const row = rows[0];
      if (!row) {
        // move_doc always RETURN NEXTs exactly one row on success.
        throw new NotFoundError("Document not found");
      }

      return {
        docId,
        fromMemexId,
        toMemexId,
        newHandle: row.new_handle,
        removedDecisionDeps: Number(row.removed_decision_deps),
        removedTaskDeps: Number(row.removed_task_deps),
        revokedShareTokens: Number(row.revoked_share_tokens),
      };
    },
  );
}
