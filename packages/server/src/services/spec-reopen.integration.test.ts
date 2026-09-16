// spec-566 t-8 — reopening a closed Spec is an attributed act, and the way back
// in actually works.
//
//   ac-27  a reopen with no reason is refused; a valid one records who, when and
//          why durably and surfaces on the Spec
//   ac-28  the full round trip — reopen a done Spec, edit the criterion, close it
//          again through dec-7's gate, asserting each step actually ran
//
// WHY THIS GUARD IS NOT OPTIONAL. dec-9 made a closed Spec's criteria
// un-editable (t-3's second guard). If reopening stays free and silent it is
// simply the route around that guard, and the guard buys nothing: an author who
// wants to rewrite a verified criterion reopens, edits, closes, and no record
// anywhere says a closed Spec was reopened to change what it had certified.
//
// AND WHY THE SEAM, not a new verb. Reopening already exists mechanically —
// `updateDocStatus` moves phases, and `DocDocument.tsx:1429` calls exactly that
// from the Done screen's Reopen button. A separate `reopen_spec` verb that
// recorded a reason would leave `update_doc` and the kanban drag out of Done as
// the unrecorded paths, which is the same failure in a new place. dec-10 settled
// this shape for the done-gate; this is its mirror.
//
// NOT A DUPLICATE OF spec-179's status_changed ROW, checked rather than assumed
// (t-8's fourth item). `updateDocStatus` already emits `{from, to}` into
// `activity_log`. That row has no reason column, and `activity-log-sweep.ts`
// deletes it after PULSE_RETENTION_DAYS (default 30). Unnamed and expiring —
// the same three-way gap dec-3 catalogued for retirements. The journal row
// carries the reason and outlives the sweep; the activity row still does its own
// job, which is the Pulse timeline.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { acs, documents, memexes, namespaces, specLifecycleEvents, users } from "../db/schema.js";
import { createAc, updateAc } from "./acs.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { countReopensForBriefs, ReopenNeedsReasonError } from "./spec-reopen.js";
import { upsertUserByEmail } from "./users.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
let actorUserId: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

/** A Spec closed with one criterion on it. */
async function seedClosedSpec(opts: { verified?: boolean } = {}): Promise<{
  briefId: string;
  acId: string;
}> {
  const doc = await createDocDraft(memexId, "reopen fixture", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement: "The exporter reconciles to the ledger.",
  });
  if (opts.verified) {
    const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
    createdRefs.push(ref);
    await seedTestEvent({
      subjectRef: ref,
      status: "pass",
      testIdentifier: "packages/server/src/exporter.test.ts::reconciles",
    });
  }
  await updateDocStatus(memexId, doc.id, "done");
  return { briefId: doc.id, acId: ac.id };
}

async function statusOf(briefId: string): Promise<string> {
  const row = await db.query.documents.findFirst({ where: eq(documents.id, briefId) });
  return row!.status;
}

beforeAll(async () => {
  memexId = await makeTestMemex("rop566");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
  const user = await upsertUserByEmail(`rop566-${process.pid}@example.test`);
  actorUserId = user.id;
});

afterAll(async () => {
  await db.delete(specLifecycleEvents).where(eq(specLifecycleEvents.memexId, memexId)).catch(() => {});
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId)).catch(() => {});
  if (actorUserId) await db.delete(users).where(eq(users.id, actorUserId)).catch(() => {});
});

describe("spec-566 ac-27 — a reopen signs its name, or it does not happen", () => {
  it("REFUSES a reopen with no reason, and the Spec stays closed", async () => {
    tagAc(acRef(27));

    const { briefId } = await seedClosedSpec();
    expect(await statusOf(briefId)).toBe("done");

    await expect(updateDocStatus(memexId, briefId, "verify")).rejects.toThrow(
      ReopenNeedsReasonError,
    );

    // The claim is not "it threw" — it is that the Spec did not reopen. A guard
    // that refused after writing would pass a throw-only test, and would leave
    // exactly the silent reopen dec-9's guard exists to prevent.
    expect(await statusOf(briefId)).toBe("done");
    expect(await countReopensForBriefs(memexId, [briefId])).toEqual(new Map([[briefId, 0]]));
  });

  it("records who, when and why as COLUMNS [std-32] when a reason is given", async () => {
    tagAc(acRef(27));

    const { briefId } = await seedClosedSpec();

    await updateDocStatus(memexId, briefId, "verify", {
      reason: "the exporter criterion was certified against the wrong ledger version",
      ctx: { channel: "rest_ui", actorUserId, actorName: "LJ Reopener" },
    });

    expect(await statusOf(briefId)).toBe("verify");

    const [row] = await db
      .select()
      .from(specLifecycleEvents)
      .where(eq(specLifecycleEvents.briefId, briefId));

    expect(row!.kind).toBe("spec_reopened");
    expect(row!.reason).toBe(
      "the exporter criterion was certified against the wrong ledger version",
    );
    expect(row!.actorUserId).toBe(actorUserId);
    expect(row!.actorName).toBe("LJ Reopener");
    expect(row!.channel).toBe("rest_ui");
    expect(row!.createdAt).toBeInstanceOf(Date);
    // The phase move it records, so a reader can tell a reopen from any other
    // lifecycle row without joining back to the activity log.
    expect(row!.fromStatus).toBe("done");
    expect(row!.toStatus).toBe("verify");

    expect(await countReopensForBriefs(memexId, [briefId])).toEqual(new Map([[briefId, 1]]));
  });

  it("leaves every OTHER transition free — only LEAVING done is gated", async () => {
    tagAc(acRef(27));

    // Scope guard. A reason demanded on every phase move would pass the two
    // cases above while making the whole board unusable.
    const doc = await createDocDraft(memexId, "ordinary moves", "purpose", "spec");
    createdDocIds.push(doc.id);

    await updateDocStatus(memexId, doc.id, "specify");
    await updateDocStatus(memexId, doc.id, "build");
    await updateDocStatus(memexId, doc.id, "verify");
    // Backward, without a reason, on a Spec that was never closed.
    await updateDocStatus(memexId, doc.id, "build");
    expect(await statusOf(doc.id)).toBe("build");

    // …and closing needs no reason either. Only the way back OUT of done does.
    await updateDocStatus(memexId, doc.id, "done");
    expect(await statusOf(doc.id)).toBe("done");
    expect(await countReopensForBriefs(memexId, [doc.id])).toEqual(new Map([[doc.id, 0]]));
  });
});

describe("spec-566 ac-28 — the sanctioned path actually works, end to end", () => {
  it("reopen → edit the criterion → close again, each step asserted", async () => {
    tagAc(acRef(28));

    // A CLOSED Spec whose criterion is VERIFIED. Both halves matter: t-3's
    // guards refuse an edit because the Spec is done AND because the criterion
    // reads as satisfied, so a fixture missing either would clear a guard that
    // was never armed.
    const { briefId, acId } = await seedClosedSpec({ verified: true });
    expect(await statusOf(briefId)).toBe("done");

    // ── Step 0: the guard is real ──
    await expect(updateAc(memexId, acId, "A rewritten claim.")).rejects.toThrow(/reopen/i);

    // ── Step 1: reopen, attributed ──
    await updateDocStatus(memexId, briefId, "verify", {
      reason: "the criterion certified the wrong thing and must be corrected",
      ctx: { channel: "mcp", actorUserId },
    });
    expect(await statusOf(briefId)).toBe("verify");

    // ── Step 2: the edit the reopen exists for ──
    // A verified criterion is still refused (dec-8's second door stays shut —
    // reopening does not unlock it), so the honest correction goes through the
    // supersession verb. The criterion this round trip edits is therefore an
    // unverified one, which is the population dec-8 leaves free.
    const second = await createAc({
      memexId,
      briefId,
      kind: "implementation",
      statement: "A second, untested claim.",
    });
    await updateAc(memexId, second.id, "A second claim, corrected.");
    const readBack = await db.query.acs.findFirst({ where: eq(acs.id, second.id) });
    expect(readBack!.statement).toBe("A second claim, corrected.");

    // ── Step 3: close it again, through dec-7's gate ──
    // Nothing is superseded here, so the gate has nothing to refuse — asserted
    // by the close actually landing rather than by reasoning about it.
    await updateDocStatus(memexId, briefId, "done");
    expect(await statusOf(briefId)).toBe("done");

    // And the round trip left its trace: one reopen, on the record.
    expect(await countReopensForBriefs(memexId, [briefId])).toEqual(new Map([[briefId, 1]]));
  });

  it("a second reopen is counted too — the count is of acts, not of a flag", async () => {
    tagAc(acRef(28));

    const { briefId } = await seedClosedSpec();

    await updateDocStatus(memexId, briefId, "verify", {
      reason: "first correction",
      ctx: { channel: "mcp", actorUserId },
    });
    await updateDocStatus(memexId, briefId, "done");
    await updateDocStatus(memexId, briefId, "verify", {
      reason: "second correction",
      ctx: { channel: "mcp", actorUserId },
    });

    // A boolean "was reopened" would satisfy every assertion in the case above
    // and lose the difference between a Spec corrected once and one reopened
    // five times — which is the whole signal dec-9 asks to be visible.
    expect(await countReopensForBriefs(memexId, [briefId])).toEqual(new Map([[briefId, 2]]));
  });
});
