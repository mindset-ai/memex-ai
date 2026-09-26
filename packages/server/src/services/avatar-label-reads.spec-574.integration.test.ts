// spec-574 t-2 — every server read that already joins `users` for a person's avatar
// carries their nominated letters, and nominating letters never rewrites a stamped
// author name.
//
// ac-9:  listAssignees, listAssigneesForDocs, listDocs({ includeAssignees }) and
//        listOrgMembers carry `avatarLabel` (null when unset); the roster carries `name`.
// ac-12: setting letters leaves every stamped actor_name unchanged (std-32).
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

import { db } from "../db/connection.js";
import { docSections, documents, orgMemberships, users, memexes, namespaces } from "../db/schema.js";
import { createDocDraft, listDocs } from "./documents.js";
import { assign, listAssignees, listAssigneesForDocs } from "./doc-assignees.js";
import { listOrgMembers, setAvatarLabel, upsertUserByEmail } from "./users.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-574";
const AC_READS = `${SPEC}/acs/ac-9`;
const AC_STAMPS = `${SPEC}/acs/ac-12`;

// std-37 cl-1: unique per worker and per call.
function uniqueEmail(tag: string): string {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `spec574-${tag}-${worker}-${tail}@example.test`;
}

const createdDocIds: string[] = [];
const createdUserIds: string[] = [];

let memexId: string;
let orgId: string;
let labelled: { id: string };
let plain: { id: string };

beforeAll(async () => {
  ({ memexId } = await makeTestMemexWithDevAdmin("s574"));
  const [mx] = await db.select().from(memexes).where(eq(memexes.id, memexId));
  const [ns] = await db.select().from(namespaces).where(eq(namespaces.id, mx!.namespaceId));
  orgId = ns!.ownerOrgId!;

  labelled = await upsertUserByEmail(uniqueEmail("labelled"));
  plain = await upsertUserByEmail(uniqueEmail("plain"));
  createdUserIds.push(labelled.id, plain.id);
  await db.update(users).set({ name: "Labelled Person" }).where(eq(users.id, labelled.id));
  await db.update(users).set({ name: "Plain Person" }).where(eq(users.id, plain.id));
  await setAvatarLabel(labelled.id, "LV");

  await db.insert(orgMemberships).values([
    { userId: labelled.id, orgId, role: "member" },
    { userId: plain.id, orgId, role: "member" },
  ]);
});

afterAll(async () => {
  if (createdDocIds.length > 0) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(orgMemberships).where(inArray(orgMemberships.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function specWithBothAssigned(): Promise<string> {
  const doc = await createDocDraft(memexId, "Avatar reads", "Fixture for spec-574.", "spec");
  createdDocIds.push(doc.id);
  await assign(memexId, doc.id, labelled.id, labelled.id);
  await assign(memexId, doc.id, plain.id, labelled.id);
  return doc.id;
}

function labelsById(rows: { userId: string; avatarLabel?: string | null }[]) {
  return Object.fromEntries(rows.map((r) => [r.userId, r.avatarLabel]));
}

describe("spec-574 ac-9: reads that join users carry the nominated letters", () => {
  it("listAssignees (the Spec byline) carries avatarLabel, null when unset", async () => {
    tagAc(AC_READS);
    const docId = await specWithBothAssigned();
    const rows = await listAssignees(memexId, docId);
    expect(rows).toHaveLength(2);
    expect(labelsById(rows)).toEqual({ [labelled.id]: "LV", [plain.id]: null });
  });

  it("listAssigneesForDocs and the board's listDocs projection carry avatarLabel", async () => {
    tagAc(AC_READS);
    const docId = await specWithBothAssigned();

    const byDoc = await listAssigneesForDocs(memexId, [docId]);
    expect(labelsById(byDoc.get(docId)!)).toEqual({ [labelled.id]: "LV", [plain.id]: null });

    const summaries = await listDocs(memexId, { docType: "spec", includeAssignees: true });
    const card = summaries.find((s) => s.id === docId);
    expect(card?.assignees).toHaveLength(2);
    expect(labelsById(card!.assignees!)).toEqual({ [labelled.id]: "LV", [plain.id]: null });
  });

  it("listOrgMembers (the team roster) carries name and avatarLabel", async () => {
    tagAc(AC_READS);
    const members = await listOrgMembers(orgId);
    const mine = members.filter((m) => createdUserIds.includes(m.userId));
    expect(mine).toHaveLength(2);
    const byId = Object.fromEntries(mine.map((m) => [m.userId, m]));
    expect(byId[labelled.id]).toMatchObject({ name: "Labelled Person", avatarLabel: "LV" });
    expect(byId[plain.id]).toMatchObject({ name: "Plain Person", avatarLabel: null });
  });
});

describe("spec-574 ac-12: nominating letters never rewrites stamped attribution", () => {
  it("actor_name on existing rows is unchanged, and new rows still stamp the name", async () => {
    tagAc(AC_STAMPS);
    const author = await upsertUserByEmail(uniqueEmail("author"));
    createdUserIds.push(author.id);
    await db.update(users).set({ name: "Stamped Author" }).where(eq(users.id, author.id));

    const writeDoc = async (title: string) => {
      const doc = await createDocDraft(memexId, title, "Fixture for spec-574 ac-12.", "spec",
        undefined, undefined, author.id, { actorUserId: author.id, channel: "rest_ui" });
      createdDocIds.push(doc.id);
      const rows = await db
        .select({ actorName: docSections.actorName })
        .from(docSections)
        .where(eq(docSections.docId, doc.id));
      return rows.map((r) => r.actorName);
    };

    const before = await writeDoc("Before nominating letters");
    expect(before.length).toBeGreaterThan(0);
    expect(new Set(before)).toEqual(new Set(["Stamped Author"]));

    await setAvatarLabel(author.id, "SA");

    const [again] = await db.select({ id: documents.id }).from(documents)
      .where(eq(documents.id, createdDocIds[createdDocIds.length - 1]!));
    const reread = await db.select({ actorName: docSections.actorName }).from(docSections)
      .where(eq(docSections.docId, again!.id));
    expect(new Set(reread.map((r) => r.actorName))).toEqual(new Set(["Stamped Author"]));

    // The letters are an avatar, not a name: a new write still stamps the display name.
    const after = await writeDoc("After nominating letters");
    expect(new Set(after)).toEqual(new Set(["Stamped Author"]));
  });
});
