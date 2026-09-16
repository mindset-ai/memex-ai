// spec-566 t-7 — the done-gate refuses, and the override clears it on the record.
//
//   ac-20  the verify→done transition is actually BLOCKED when an unaccepted
//          proposal exists, and the message names the criterion and the call
//          that clears it
//   ac-21  an override with no reason is refused; a valid one records
//          who/when/why as columns [std-32] and clears the gate — including for
//          a Spec already sitting in `verify`, by the same path, with no
//          separate grandfathering
//   ac-29  the refusal is TYPED, so the board can tell it from a server fault
//          (the server half; the board half is in packages/ui)
//
// WHY "ASSERT THE TRANSITION IS BLOCKED" IS THE WHOLE POINT. ac-20 says it in as
// many words: "a gate that warns and lets the close through fails this". So every
// case here reads the document's status BACK from the database after the refused
// call. A test that only asserted the throw would pass against a gate that
// refused after writing.
//
// AND WHY THE SEAM MATTERS. dec-10 put the refusal in `updateDocStatus` — the one
// function the kanban REST route, MCP `update_doc` and the lifecycle path all
// funnel through — precisely so there is no cheaper, unattributed exit. These
// tests drive that function directly, which is the shared seam; the board's own
// behaviour on the typed refusal is asserted in the UI suite.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, specLifecycleEvents, users } from "../db/schema.js";
import { createAc } from "./acs.js";
import { proposeAcSupersession } from "./ac-supersession.js";
import { createDecision } from "./decisions.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import {
  DONE_GATE_BLOCKED,
  DoneGateBlockedError,
  countGateOverridesForBriefs,
  listDoneGateBlockers,
  overrideDoneGate,
} from "./done-gate.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const STATEMENT = "The exporter reconciles to the ledger, line by line.";

let memexId: string;
let actorUserId: string;
const createdDocIds: string[] = [];

/** A Spec in `verify` holding one unaccepted supersession proposal. */
async function seedBlockedSpec(): Promise<{ briefId: string; acSeq: number }> {
  const doc = await createDocDraft(memexId, "done-gate fixture", "purpose", "spec");
  createdDocIds.push(doc.id);

  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement: STATEMENT,
  });
  const decision = await createDecision(
    memexId,
    doc.id,
    "Billing moved to line-item granularity",
  );
  await proposeAcSupersession(
    { memexId, acId: ac.id, decisionId: decision.id },
    { channel: "mcp" },
  );

  // The Spec is in `verify` — the state the gate actually guards, and the one
  // ac-21 asks about for work already in flight.
  await updateDocStatus(memexId, doc.id, "verify");

  return { briefId: doc.id, acSeq: ac.seq };
}

async function statusOf(briefId: string): Promise<string> {
  const row = await db.query.documents.findFirst({ where: eq(documents.id, briefId) });
  return row!.status;
}

beforeAll(async () => {
  memexId = await makeTestMemex("gate566");
  const user = await upsertUserByEmail(`gate566-${process.pid}@example.test`);
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

describe("spec-566 ac-20 — the gate refuses, and says what clears it", () => {
  it("BLOCKS verify→done and leaves the Spec in verify", async () => {
    tagAc(acRef(20));

    const { briefId } = await seedBlockedSpec();

    // Precondition: the Spec really is one step from closing, and the gate
    // really has something to refuse. Without both, the refusal below could be
    // about anything.
    expect(await statusOf(briefId)).toBe("verify");
    expect(await listDoneGateBlockers(memexId, briefId)).toHaveLength(1);

    await expect(updateDocStatus(memexId, briefId, "done")).rejects.toThrow(
      DoneGateBlockedError,
    );

    // THE claim ac-20 makes: not "it threw", but "it did not close". A gate that
    // warns and lets the close through fails this, and would pass a test that
    // only checked the throw.
    expect(await statusOf(briefId)).toBe("verify");
  });

  it("names the criterion and the exact calls that clear it [std-53]", async () => {
    tagAc(acRef(20));

    const { briefId, acSeq } = await seedBlockedSpec();

    const err = await updateDocStatus(memexId, briefId, "done").catch((e) => e);
    expect(err).toBeInstanceOf(DoneGateBlockedError);
    const message = (err as Error).message;

    // WHICH criterion — by handle and by its words. "This Spec has unresolved
    // issues" is the defect dec-7 names.
    expect(message).toContain(`ac-${acSeq}`);
    expect(message).toContain(STATEMENT);
    // The outcome, not the worry: the calls that resolve it, and the one that
    // proceeds anyway.
    expect(message).toContain("accept_ac_supersession");
    expect(message).toContain("reject_ac_supersession");
    expect(message).toContain("override_done_gate");
  });

  it("carries the typed discriminator, not a bare error [ac-29, server half]", async () => {
    tagAc(acRef(20));
    tagAc(acRef(29));

    const { briefId } = await seedBlockedSpec();
    const err = (await updateDocStatus(memexId, briefId, "done").catch((e) => e)) as
      DoneGateBlockedError;

    // This code is the entire reason a block at this seam is survivable where
    // spec-391's was not: the board switches on it to open the override dialog
    // rather than rolling the card back in silence. Asserted here because an
    // untyped refusal reads identically to a typed one from the throw alone.
    expect(err.code).toBe(DONE_GATE_BLOCKED);
    expect(err.blockers).toHaveLength(1);
  });

  it("leaves every OTHER transition alone, and every Spec with no proposal", async () => {
    tagAc(acRef(20));

    // Scope guard. A gate that refused more than dec-7 asked for would pass
    // every case above while breaking the product.
    const { briefId } = await seedBlockedSpec();

    // Backward, and forward-but-not-done, both still work on a blocked Spec.
    await updateDocStatus(memexId, briefId, "build");
    expect(await statusOf(briefId)).toBe("build");
    await updateDocStatus(memexId, briefId, "verify");
    expect(await statusOf(briefId)).toBe("verify");

    // And a Spec holding no proposal closes exactly as it always did.
    const clean = await createDocDraft(memexId, "unblocked fixture", "purpose", "spec");
    createdDocIds.push(clean.id);
    await updateDocStatus(memexId, clean.id, "done");
    expect(await statusOf(clean.id)).toBe("done");
  });
});

describe("spec-566 ac-21 — the override is attributed, or it is refused", () => {
  it("refuses an override with no reason, and clears nothing", async () => {
    tagAc(acRef(21));

    const { briefId } = await seedBlockedSpec();

    await expect(overrideDoneGate(memexId, briefId, "   ", { channel: "rest_ui" })).rejects.toThrow(
      /reason/i,
    );

    // The refusal is total: no journal row, and the gate still refuses. A guard
    // that rejected AFTER writing would pass a test that only checked the throw.
    expect(await countGateOverridesForBriefs(memexId, [briefId])).toEqual(
      new Map([[briefId, 0]]),
    );
    await expect(updateDocStatus(memexId, briefId, "done")).rejects.toThrow(
      DoneGateBlockedError,
    );
    expect(await statusOf(briefId)).toBe("verify");
  });

  it("records who, when and why as COLUMNS [std-32], and then the Spec closes", async () => {
    tagAc(acRef(21));

    const { briefId } = await seedBlockedSpec();

    await overrideDoneGate(
      memexId,
      briefId,
      "the proposal is stale; the criterion is being retired under dec-4 next sprint",
      { channel: "rest_ui", actorUserId, actorName: "LJ Overrider" },
    );

    const [row] = await db
      .select()
      .from(specLifecycleEvents)
      .where(eq(specLifecycleEvents.briefId, briefId));

    // Each of these is a first-class column, not a key in a payload bag — the
    // count and any review have to filter on them [std-32].
    expect(row!.kind).toBe("gate_overridden");
    expect(row!.reason).toBe(
      "the proposal is stale; the criterion is being retired under dec-4 next sprint",
    );
    expect(row!.actorUserId).toBe(actorUserId);
    expect(row!.actorName).toBe("LJ Overrider");
    expect(row!.channel).toBe("rest_ui");
    expect(row!.createdAt).toBeInstanceOf(Date);

    // …and the gate is clear. Read the status back: "the override returned
    // successfully" is not the claim.
    expect(await listDoneGateBlockers(memexId, briefId)).toEqual([]);
    await updateDocStatus(memexId, briefId, "done");
    expect(await statusOf(briefId)).toBe("done");
  });

  it("a Spec already in verify clears by the SAME path — no grandfathering", async () => {
    tagAc(acRef(21));

    // dec-7's blast-radius answer: Specs in flight the day this ships are
    // neither frozen nor exempt. The fixture is already in `verify`, which IS
    // that population — there is nothing separate to build, so this asserts the
    // path rather than a migration.
    const { briefId } = await seedBlockedSpec();
    expect(await statusOf(briefId)).toBe("verify");

    await expect(updateDocStatus(memexId, briefId, "done")).rejects.toThrow(
      DoneGateBlockedError,
    );

    await overrideDoneGate(memexId, briefId, "in flight when the gate shipped", {
      channel: "rest_ui",
      actorUserId,
    });
    await updateDocStatus(memexId, briefId, "done");

    expect(await statusOf(briefId)).toBe("done");
  });

  it("refuses an override when there is nothing to override", async () => {
    tagAc(acRef(21));

    const clean = await createDocDraft(memexId, "nothing to override", "purpose", "spec");
    createdDocIds.push(clean.id);

    await expect(
      overrideDoneGate(memexId, clean.id, "just in case", { channel: "rest_ui" }),
    ).rejects.toThrow(/nothing to override/i);

    // An override recorded against nothing would inflate dec-7's anti-decay
    // count, which is the one signal keeping option C from becoming option B.
    expect(await countGateOverridesForBriefs(memexId, [clean.id])).toEqual(
      new Map([[clean.id, 0]]),
    );
  });

  it("a proposal filed AFTER an override re-arms the gate", async () => {
    tagAc(acRef(21));

    const doc = await createDocDraft(memexId, "re-arm fixture", "purpose", "spec");
    createdDocIds.push(doc.id);
    const decision = await createDecision(memexId, doc.id, "A decision to supersede under");

    const first = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: "The first claim.",
    });
    await proposeAcSupersession(
      { memexId, acId: first.id, decisionId: decision.id },
      { channel: "mcp" },
    );
    await overrideDoneGate(memexId, doc.id, "first one waved through", {
      channel: "rest_ui",
      actorUserId,
    });
    expect(await listDoneGateBlockers(memexId, doc.id)).toEqual([]);

    // A second criterion is proposed for supersession after the override.
    const second = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: "The second claim.",
    });
    await proposeAcSupersession(
      { memexId, acId: second.id, decisionId: decision.id },
      { channel: "mcp" },
    );

    // One override must not license every later rewrite — that is the permanent
    // exemption the watermark exists to prevent.
    expect(await listDoneGateBlockers(memexId, doc.id)).toHaveLength(1);
    await expect(updateDocStatus(memexId, doc.id, "done")).rejects.toThrow(
      DoneGateBlockedError,
    );
  });
});
