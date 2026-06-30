import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { specCheckoutEdits, type SpecCheckoutEdit } from "../db/schema.js";

// spec-371: the edit-ledger half of the checkout domain. The durable CHECKOUT
// RECORD (who/when/thread on the document) lives in services/checkout.ts; the
// merged v1's presence-coupled claim (claimSpecPresence/releaseSpecPresence) is
// removed — checkout is no longer a presence write (dec-5). v1 is RECORD-ONLY (dec-8) — the phone-home
// records an edit against the claimed spec, feeding spec-125's durable stream and
// the commit/branch/thread footprint join key later specs hang off.
//
// Like presence and the test_event firehose, an edit record is high-frequency,
// out-of-band telemetry, so it is a PLAIN insert (NOT routed through mutate()/the
// bus): there is no live activity line to drive in v1, and a per-edit bus emit
// would be the wrong cost on a hot path.

export interface RecordCheckoutEditInput {
  memexId: string;
  /** The spec's documents.id. */
  docId: string;
  /** The agent thread's hook session id — the local-marker key (dec-1/dec-3). */
  threadUid: string;
  /** The files the edit touched. */
  changedPaths: string[];
  /** Git footprint, when the hook could read it. */
  commitSha?: string | null;
  branch?: string | null;
  /** The user the hook key resolved to. */
  actorUserId?: string | null;
}

export async function recordCheckoutEdit(
  input: RecordCheckoutEditInput,
): Promise<SpecCheckoutEdit> {
  const [row] = await db
    .insert(specCheckoutEdits)
    .values({
      memexId: input.memexId,
      docId: input.docId,
      threadUid: input.threadUid,
      changedPaths: input.changedPaths,
      commitSha: input.commitSha ?? null,
      branch: input.branch ?? null,
      actorUserId: input.actorUserId ?? null,
    })
    .returning();
  return row;
}

// The footprint join key reads: every recorded edit for a spec, newest first.
export async function listCheckoutEditsForSpec(
  memexId: string,
  docId: string,
): Promise<SpecCheckoutEdit[]> {
  return db.query.specCheckoutEdits.findMany({
    where: and(
      eq(specCheckoutEdits.memexId, memexId),
      eq(specCheckoutEdits.docId, docId),
    ),
    orderBy: [desc(specCheckoutEdits.createdAt)],
  });
}

