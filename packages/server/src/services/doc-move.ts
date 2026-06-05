import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  docComments,
  decisions,
  tasks,
  shareTokens,
  orgMemberships,
  memexes,
  namespaces,
} from "../db/schema.js";
import type { Doc } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { nextSpecHandle, nextDocHandle } from "./documents.js";

// Error surfaced when the caller isn't a member of the target memex.
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface MoveDocOptions {
  includeDecisions: boolean;
  includeTasks: boolean;
  includeSectionComments: boolean;
}

export interface MoveDocResult {
  doc: Doc;
  fromMemexId: string;
  toMemexId: string;
  newHandle: string;
  // Counts of dep rows that were deleted because they straddled two accounts after the move.
  removedDecisionDeps: number;
  removedTaskDeps: number;
  // Count of share tokens revoked on move (public URLs are subdomain-scoped by convention,
  // so they'd effectively stop working anyway once the doc leaves the source subdomain).
  revokedShareTokens: number;
}

// Moves a Spec from one memex to another. The doc's UUID is preserved so anything
// FK-linked (sections, decisions, tasks, comments, conversations, share tokens) stays
// attached — the user chooses via opts whether children also change their account scope.
//
// Children whose memex_id is not updated remain "orphaned" in the source memex: they
// still FK to the moved doc, so if the doc is moved back later they re-appear.
//
// Semantic rules that aren't configurable:
//   - Sections always follow the doc (they don't carry memex_id — scoped via doc_id).
//   - Decision-comments follow their decisions; task-comments follow their tasks. Only
//     section-comments have an independent checkbox (includeSectionComments).
//   - Any decision/task dep edges whose endpoints end up in different accounts are
//     deleted after the move (silent per product decision). Counts are returned so the
//     UI can surface a toast.
//   - All share tokens for the doc are revoked on move.
export async function moveDoc(
  fromMemexId: string,
  docId: string,
  toMemexId: string,
  userId: string,
  opts: MoveDocOptions,
): Promise<Mutated<MoveDocResult>> {
  if (fromMemexId === toMemexId) {
    throw new ValidationError("Source and target memex must differ");
  }

  // Cross-tenant emit: notify both the source and target memex so list views in
  // either tenant refetch. mutate() runs the transaction once and emits both
  // events on success (the two keys are independent invariants per dec-2).
  return mutate(
    {},
    [
      { memexId: fromMemexId, docId, entity: "document", action: "updated" },
      { memexId: toMemexId, docId, entity: "document", action: "updated" },
    ],
    async () => {
  const result = await db.transaction(async (tx) => {
    // Lock the row so concurrent writes (agent/MCP/REST) serialize against the move.
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, docId), eq(documents.memexId, fromMemexId)))
      .for("update");

    if (!doc) {
      throw new NotFoundError(`Document ${docId} not found`);
    }

    // Caller must be allowed to write to the target memex: either they own its
    // namespace (personal memex) or have an active org_membership in the org that
    // owns its namespace.
    const targetMemex = await tx.query.memexes.findFirst({
      where: eq(memexes.id, toMemexId),
    });
    if (!targetMemex) {
      throw new NotFoundError(`Memex ${toMemexId} not found`);
    }
    const targetNs = await tx.query.namespaces.findFirst({
      where: eq(namespaces.id, targetMemex.namespaceId),
    });
    let allowed = false;
    if (targetNs?.kind === "user" && targetNs.ownerUserId === userId) {
      allowed = true;
    } else if (targetNs?.kind === "org" && targetNs.ownerOrgId) {
      const membership = await tx.query.orgMemberships.findFirst({
        where: and(
          eq(orgMemberships.userId, userId),
          eq(orgMemberships.orgId, targetNs.ownerOrgId),
          eq(orgMemberships.status, "active"),
        ),
      });
      if (membership) allowed = true;
    }
    if (!allowed) {
      throw new ForbiddenError("You are not a member of the target Memex");
    }

    // Per doc-30 dec-1 + dec-3: specs get a `spec-N` handle on move; everything
    // else (free-form documents, execution-plans, legacy docTypes) keeps `doc-N`.
    const newHandle = doc.docType === "spec"
      ? await nextSpecHandle(toMemexId, tx)
      : await nextDocHandle(toMemexId, tx);

    const [updatedDoc] = await tx
      .update(documents)
      .set({ memexId: toMemexId, handle: newHandle })
      .where(eq(documents.id, docId))
      .returning();

    // Sections have no memex_id — they follow the doc via doc_id FK.

    // Section comments: move iff includeSectionComments. Resolved via doc_sections ⇒ doc.
    if (opts.includeSectionComments) {
      await tx.execute(sql`
        UPDATE doc_comments
           SET memex_id = ${toMemexId}
         WHERE section_id IN (SELECT id FROM doc_sections WHERE doc_id = ${docId})
      `);
    }

    // Decisions + their comments travel as a unit. If includeDecisions=false, both stay
    // behind with memex_id = fromMemexId and orphan in the source.
    if (opts.includeDecisions) {
      await tx
        .update(decisions)
        .set({ memexId: toMemexId })
        .where(eq(decisions.docId, docId));

      await tx.execute(sql`
        UPDATE doc_comments
           SET memex_id = ${toMemexId}
         WHERE decision_id IN (SELECT id FROM decisions WHERE doc_id = ${docId})
      `);
    }

    // Tasks + their comments travel as a unit (same logic). includeTasks keeps its
    // legacy name on the option since it's the user-visible "Tasks" checkbox.
    if (opts.includeTasks) {
      await tx
        .update(tasks)
        .set({ memexId: toMemexId })
        .where(eq(tasks.docId, docId));

      await tx.execute(sql`
        UPDATE doc_comments
           SET memex_id = ${toMemexId}
         WHERE task_id IN (SELECT id FROM tasks WHERE doc_id = ${docId})
      `);
    }

    // After the ownership updates, any dep row that now straddles two accounts is
    // structurally invalid (the blocking/blocked entities live in different memexes and
    // the blocked user can no longer see the blocker). Silent-delete per product decision;
    // return the count so the UI can surface a toast.
    //
    // Note: cross-account is the structural guard here even though dec-11 dropped the
    // intra-doc constraint. Cross-doc is fine; cross-account isn't.
    //
    // Using `RETURNING 1` and counting the result array avoids relying on driver-specific
    // rowCount shape (postgres-js via Drizzle returns the rows, not a pg-style result).
    const decisionDepResult = (await tx.execute(sql`
      DELETE FROM decision_deps dd
       USING tasks w, decisions d
       WHERE dd.task_id = w.id
         AND dd.decision_id = d.id
         AND w.memex_id <> d.memex_id
         AND (w.doc_id = ${docId} OR d.doc_id = ${docId})
      RETURNING 1
    `)) as unknown as unknown[];

    const taskDepResult = (await tx.execute(sql`
      DELETE FROM task_deps wd
       USING tasks w1, tasks w2
       WHERE wd.task_id = w1.id
         AND wd.depends_on_id = w2.id
         AND w1.memex_id <> w2.memex_id
         AND (w1.doc_id = ${docId} OR w2.doc_id = ${docId})
      RETURNING 1
    `)) as unknown as unknown[];

    // Revoke all active share tokens for the doc. Public share URLs are served from the
    // source subdomain and would stop resolving after the move; mark them revoked to make
    // the state explicit (and audit-friendly) rather than silently broken.
    const revokeResult = (await tx.execute(sql`
      UPDATE share_tokens
         SET revoked = TRUE
       WHERE document_id = ${docId}
         AND revoked = FALSE
      RETURNING 1
    `)) as unknown as unknown[];

    return {
      doc: updatedDoc,
      newHandle,
      removedDecisionDeps: decisionDepResult.length,
      removedTaskDeps: taskDepResult.length,
      revokedShareTokens: revokeResult.length,
    };
  });

  return {
    doc: result.doc,
    fromMemexId,
    toMemexId,
    newHandle: result.newHandle,
    removedDecisionDeps: result.removedDecisionDeps,
    removedTaskDeps: result.removedTaskDeps,
    revokedShareTokens: result.revokedShareTokens,
  };
    },
  );
}
