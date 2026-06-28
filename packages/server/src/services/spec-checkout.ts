import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { specCheckoutEdits, type SpecCheckoutEdit } from "../db/schema.js";
import {
  markPresent,
  clearPresent,
  listPresent,
  type PresenceChannel,
  type ActorKind,
} from "./presence.js";

// spec-371: the checkout domain. v1 is RECORD-ONLY (dec-8) — the phone-home
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

// ── Claim presence (the soft lock, dec-5) ───────────────────────────────────

export interface ClaimPresenceInput {
  memexId: string;
  docId: string;
  actorUserId: string;
  actorName?: string | null;
  actorKind: ActorKind;
  channel: PresenceChannel;
  clientId?: string;
}

// Record a claim's SOFT presence and return who ELSE is currently present on the
// Spec (excluding this exact session) — the soft-lock surface. No hard lock, no
// eviction; teammates simply become visible to each other (dec-5).
export async function claimSpecPresence(
  input: ClaimPresenceInput,
): Promise<{ othersPresent: string[] }> {
  await markPresent({
    memexId: input.memexId,
    docId: input.docId,
    actorUserId: input.actorUserId,
    actorName: input.actorName ?? null,
    actorKind: input.actorKind,
    channel: input.channel,
    clientId: input.clientId,
  });
  const present = await listPresent(input.memexId, input.docId);
  const others = present.filter(
    (p) => !(p.actorUserId === input.actorUserId && p.clientId === (input.clientId ?? "")),
  );
  const othersPresent = [
    ...new Set(others.map((p) => p.actorName).filter((n): n is string => !!n)),
  ];
  return { othersPresent };
}

// Explicit check-in: drop this session's presence so the Spec reads as free again.
export async function releaseSpecPresence(input: {
  docId: string;
  actorUserId: string;
  channel: PresenceChannel;
  clientId?: string;
}): Promise<void> {
  await clearPresent(input);
}
