// spec-315 t-5 — "Where you're needed" derivation.
// ac-7 (mechanism: union of mentions-me + open assigned-to-me, deduped with assignment
// ranked above mention, cross-memex, against spec-320's tables) and ac-1 (outcome:
// lists the comments that tag the user, each linking to the exact spec).
//
// Isolation: a UNIQUE owner user scoped to this test's memexes (the read is global
// across the user's memberships). Tests run as the table OWNER (RLS bypassed, std-36);
// the service's explicit memex_id filters + membership iteration do the scoping.
import { beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgMemberships, orgs } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { addComment, resolveComment } from "./comments.js";
import { addMentions, assignComment } from "./comment-mentions.js";
import { listWhereYoureNeededForUser } from "./where-youre-needed.js";

const AC1 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-1";
const AC7 = "mindset-prod/memex-building-itself/specs/spec-315/acs/ac-7";

const rand = () => Math.random().toString(36).slice(2, 8);
let slugSeq = 0;
function uniqueSlug(prefix: string): string {
  slugSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${slugSeq}-${rand()}`.slice(0, 39);
}

async function makeMemex(prefix: string, adminUserId: string): Promise<{ memexId: string; slug: string }> {
  const slug = uniqueSlug(prefix);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx.insert(orgs).values({ namespaceId: ns.id, name: `Test ${prefix}` }).returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  await db
    .insert(orgMemberships)
    .values({ userId: adminUserId, orgId: org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: memex.id, slug: ns.slug };
}

async function makeSpecWithSection(memexId: string, title: string) {
  const doc = await createDocDraft(memexId, title, "purpose", "spec");
  return { docId: doc.id, handle: doc.handle, sectionId: doc.sections[0]!.id };
}

describe("listWhereYoureNeededForUser (spec-315 t-5)", () => {
  let owner: string;
  let alice: string;
  let slugA: string;
  let memexA: string;
  let handleA: string;
  // comment ids
  let cMention: string;
  let cAssign: string;
  let cAssignSeq: number;
  let cMentionB: string;
  let cOther: string;
  let cMentionC: string;
  let cResolved: string;

  beforeAll(async () => {
    owner = (await upsertUserByEmail(`wyn-owner-${Date.now()}-${rand()}@example.com`)).id;
    alice = (await upsertUserByEmail(`wyn-alice-${Date.now()}-${rand()}@example.com`)).id;

    const A = await makeMemex("wyn-a", owner); // owner is a member
    const B = await makeMemex("wyn-b", owner); // owner is a member
    const C = await makeMemex("wyn-c", alice); // owner is NOT a member (alice is)
    memexA = A.memexId;
    slugA = A.slug;

    const aliceCtx = () => ({ actorUserId: alice, channel: "rest_ui" as const });

    const specA = await makeSpecWithSection(memexA, "Where-Needed Spec A");
    handleA = specA.handle;

    // owner is @-mentioned
    const m = await addComment(memexA, specA.sectionId, "Alice", "take a look here please");
    cMention = m.id;
    await addMentions(memexA, cMention, [owner], aliceCtx());

    // owner is assigned (assignComment also makes owner a mention — assignee ⊆ mentions)
    const a = await addComment(memexA, specA.sectionId, "Alice", "you own closing this");
    cAssign = a.id;
    cAssignSeq = a.seq;
    await assignComment(memexA, cAssign, owner, aliceCtx());

    // assigned then RESOLVED — drops from open-assignments; the mention remains.
    const r = await addComment(memexA, specA.sectionId, "Alice", "resolved assignment");
    cResolved = r.id;
    await assignComment(memexA, cResolved, owner, aliceCtx());
    await resolveComment(memexA, cResolved, "done");

    // ALICE is mentioned (not owner) — must not appear for owner.
    const o = await addComment(memexA, specA.sectionId, "Owner", "calling alice");
    cOther = o.id;
    await addMentions(memexA, cOther, [alice], () => ({ actorUserId: owner, channel: "rest_ui" as const }));

    // cross-memex: owner mentioned in memex B.
    const specB = await makeSpecWithSection(B.memexId, "Where-Needed Spec B");
    const mb = await addComment(B.memexId, specB.sectionId, "Alice", "B needs you");
    cMentionB = mb.id;
    await addMentions(B.memexId, cMentionB, [owner], aliceCtx());

    // tenancy: owner mentioned in memex C, but owner is NOT a member of C.
    const specC = await makeSpecWithSection(C.memexId, "Where-Needed Spec C");
    const mc = await addComment(C.memexId, specC.sectionId, "Alice", "C should be hidden");
    cMentionC = mc.id;
    await addMentions(C.memexId, cMentionC, [owner], aliceCtx());
  });

  it("unions mentions-me + open assigned-to-me, deduped with assignment ranked first (ac-1, ac-7)", async () => {
    tagAc(AC7);
    tagAc(AC1);
    const res = await listWhereYoureNeededForUser(owner);
    const byId = new Map(res.map((r) => [r.commentId, r]));

    // the assignment appears, AS an assignment
    expect(byId.get(cAssign)?.kind).toBe("assignment");
    // the mention appears, as a mention
    expect(byId.get(cMention)?.kind).toBe("mention");
    // dedupe: the assigned comment shows up exactly once (not also as a bare mention)
    expect(res.filter((r) => r.commentId === cAssign)).toHaveLength(1);
    // assignment ranked above every mention
    const firstMentionIdx = res.findIndex((r) => r.kind === "mention");
    const assignIdx = res.findIndex((r) => r.commentId === cAssign);
    expect(assignIdx).toBeLessThan(firstMentionIdx);
  });

  it("is cross-memex but only over the user's memberships (ac-7)", async () => {
    tagAc(AC7);
    const ids = (await listWhereYoureNeededForUser(owner)).map((r) => r.commentId);
    expect(ids).toContain(cMentionB); // memex B — owner is a member
    expect(ids).not.toContain(cMentionC); // memex C — owner is NOT a member (tenancy)
    expect(ids).not.toContain(cOther); // alice's mention, not owner's
  });

  it("counts only OPEN assignments; a resolved one drops to a plain mention (ac-7)", async () => {
    tagAc(AC7);
    const byId = new Map((await listWhereYoureNeededForUser(owner)).map((r) => [r.commentId, r]));
    // resolved assignment is no longer an assignment...
    expect(byId.get(cResolved)?.kind).not.toBe("assignment");
    // ...but the mention persists (assignee ⊆ mentions), so it still surfaces.
    expect(byId.get(cResolved)?.kind).toBe("mention");
  });

  it("carries owning-spec provenance + a comment-anchored route (ac-1)", async () => {
    tagAc(AC1);
    const item = (await listWhereYoureNeededForUser(owner)).find((r) => r.commentId === cAssign)!;
    expect(item.memexId).toBe(memexA);
    expect(item.namespaceSlug).toBe(slugA);
    expect(item.specHandle).toBe(handleA);
    expect(item.snippet).toBe("you own closing this");
    expect(item.path).toBe(`/${slugA}/main/specs/${handleA}#c-${cAssignSeq}`);
  });
});
