// spec-566 t-9 — an AC supersession proposal lands in the SAME queue as a
// standards proposal.
//
//   ac-10 (server half)  a pending supersession appears in the Drift Inbox
//                        beside standards proposals, carrying BOTH the original
//                        statement and the proposed one
//
// dec-1 chose the existing queue over a new surface, and t-9 hoped this
// would be "a row type and copy". It is not, and t-2's comment c-1 recorded why
// before any of it was written: `listDriftInbox` hard-scopes
// `AND d.doc_type = 'standard'`, and it resolves a comment's parent doc through
// `section_id` / `decision_id` / `task_id` only. An AC proposal hangs off
// `ac_id`, so it matched no parent at all AND was filtered out by doc type —
// two independent reasons for the row to be invisible. Either one alone would
// make a half-fixed read path look like it worked on the other.
//
// THE PAIR IS THE POINT. Every case here seeds a standards proposal too, and
// asserts it still comes back. Widening a WHERE clause is exactly the change
// that quietly drops what it used to return, and a test that only looked for
// the new row would pass on an inbox that had lost the old ones.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { createAc, updateAc } from "./acs.js";
import { proposeAcSupersession } from "./ac-supersession.js";
import { createDecision } from "./decisions.js";
import { createDocDraft } from "./documents.js";
import { listDriftInbox } from "./drift-inbox.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const ORIGINAL = "The exporter writes one row per invoice.";
const REPLACEMENT = "The exporter writes one row per invoice LINE ITEM.";

let memexId: string;
const createdDocIds: string[] = [];

/** A Spec with one criterion held under an unaccepted supersession proposal. */
async function seedProposal(opts: { replacement?: string | null } = {}): Promise<{
  briefId: string;
  acSeq: number;
  specHandle: string;
}> {
  const doc = await createDocDraft(memexId, "drift inbox fixture", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement: ORIGINAL,
  });
  const decision = await createDecision(memexId, doc.id, "Billing moved to line items");
  await proposeAcSupersession(
    {
      memexId,
      acId: ac.id,
      decisionId: decision.id,
      proposedStatement: opts.replacement === undefined ? REPLACEMENT : (opts.replacement ?? undefined),
      rationale: "the old wording is now false",
    },
    { channel: "mcp" },
  );
  return { briefId: doc.id, acSeq: ac.seq, specHandle: doc.handle! };
}

/** A standards proposal, so every case can prove the old rows survive. */
async function seedStandardsProposal(): Promise<string> {
  const std = await createDocDraft(memexId, "A standard", "purpose", "standard");
  createdDocIds.push(std.id);
  const [section] = await db.execute(
    // Raw because the section + comment shapes here are fixture plumbing, not
    // the thing under test; the service reads them the same either way.
    // eslint-disable-next-line
    (await import("drizzle-orm")).sql`
      INSERT INTO doc_sections (memex_id, doc_id, section_type, title, content, seq, position)
      VALUES (${memexId}::uuid, ${std.id}::uuid, 'rule', 'Rule', 'body', 1, 1)
      RETURNING id
    `,
  ) as unknown as Array<{ id: string }>;
  await db.execute(
    (await import("drizzle-orm")).sql`
      INSERT INTO doc_comments (memex_id, doc_id, section_id, seq, comment_type, source, author_name, content)
      VALUES (${memexId}::uuid, ${std.id}::uuid, ${section!.id}::uuid, 1, 'drift', 'agent', 'Memex agent', 'the code has drifted from this rule')
    `,
  );
  return std.handle!;
}

beforeAll(async () => {
  memexId = await makeTestMemex("dfi566");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId)).catch(() => {});
});

describe("spec-566 ac-10 — the supersession joins the queue, and nothing leaves it", () => {
  it("returns the proposal carrying the original AND the proposed statement", async () => {
    tagAc(acRef(10));

    const stdHandle = await seedStandardsProposal();
    const { specHandle, acSeq } = await seedProposal();

    const page = await listDriftInbox(memexId, { limit: 50 });

    // The standards row is still there. Asserted FIRST, because widening the
    // filter is precisely the change that drops what it used to return.
    expect(page.items.some((i) => i.doc.handle === stdHandle)).toBe(true);

    const row = page.items.find((i) => i.doc.handle === specHandle);
    expect(row, "the supersession proposal must appear in the inbox").toBeDefined();

    // It knows WHICH criterion, and the Spec it belongs to — the row has to be
    // referenceable as "ac-N on spec-M" for the agent handoff to mean anything.
    expect(row!.ac).not.toBeNull();
    expect(row!.ac!.handle).toBe(`ac-${acSeq}`);
    expect(row!.doc.docType).toBe("spec");

    // BOTH statements, which is ac-10's actual claim. One without the other is
    // an unreviewable proposal: "here is the new text" with nothing to compare.
    expect(row!.proposal).toMatchObject({
      kind: "ac-supersession",
      before: ORIGINAL,
      after: REPLACEMENT,
    });
  });

  it("carries the criterion's LIVE statement, so a drifted proposal is visible", async () => {
    tagAc(acRef(10));

    const { specHandle, briefId } = await seedProposal();

    // The criterion moves after the proposal was written. accept refuses this
    // (t-2), and the reviewer needs to SEE why rather than discovering it at
    // accept time.
    const [ac] = await db.execute(
      (await import("drizzle-orm")).sql`SELECT id FROM acs WHERE brief_id = ${briefId}::uuid LIMIT 1`,
    ) as unknown as Array<{ id: string }>;
    await updateAc(memexId, ac!.id, "The exporter writes one row per invoice, net of credits.");

    const page = await listDriftInbox(memexId, { limit: 50 });
    const row = page.items.find((i) => i.doc.handle === specHandle);

    expect(row!.proposal).toMatchObject({
      kind: "ac-supersession",
      before: ORIGINAL,
      current: "The exporter writes one row per invoice, net of credits.",
    });
    // Vacuity guard: `before` and `current` must actually differ, or this case
    // holds for a proposal nothing happened to.
    const p = row!.proposal as { before: string; current: string | null };
    expect(p.current).not.toBe(p.before);
  });

  it("renders a retirement with no successor as after: null, not as unreadable", async () => {
    tagAc(acRef(10));

    // A criterion retired with no replacement is a legitimate proposal (t-2
    // allows it). Falling through to `unreadable` would tell the reviewer the
    // payload was corrupt when it was merely empty.
    const { specHandle } = await seedProposal({ replacement: null });

    const page = await listDriftInbox(memexId, { limit: 50 });
    const row = page.items.find((i) => i.doc.handle === specHandle);

    expect(row!.proposal).toMatchObject({ kind: "ac-supersession", before: ORIGINAL, after: null });
  });

  it("does NOT sweep in ordinary Spec comments", async () => {
    tagAc(acRef(10));

    // The filter widened from "standards only" to "standards, or a comment that
    // targets a criterion". If it had widened to "any Spec comment", every
    // review note on every Spec would land in the queue — an inbox nobody can
    // use, which is a worse outcome than the row being missing.
    const doc = await createDocDraft(memexId, "a spec with chatter", "purpose", "spec");
    createdDocIds.push(doc.id);
    const [section] = await db.execute(
      (await import("drizzle-orm")).sql`
        INSERT INTO doc_sections (memex_id, doc_id, section_type, title, content, seq, position)
        VALUES (${memexId}::uuid, ${doc.id}::uuid, 'architecture', 'Architecture', 'body', 2, 2)
        RETURNING id
      `,
    ) as unknown as Array<{ id: string }>;
    await db.execute(
      (await import("drizzle-orm")).sql`
        INSERT INTO doc_comments (memex_id, doc_id, section_id, seq, comment_type, source, author_name, content)
        VALUES (${memexId}::uuid, ${doc.id}::uuid, ${section!.id}::uuid, 1, 'plan_revision', 'agent', 'Memex agent', 'a revision note on a Spec section')
      `,
    );

    const page = await listDriftInbox(memexId, { limit: 50 });
    expect(page.items.some((i) => i.doc.handle === doc.handle)).toBe(false);
  });
});
