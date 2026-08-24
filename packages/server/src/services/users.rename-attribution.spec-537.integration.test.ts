import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

import { db } from "../db/connection.js";
import { docSections, documents, users } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { updateUserProfile, upsertUserByEmail } from "./users.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";

// spec-537 t-5 (ac-13) — renaming a user must NOT rewrite historical attribution.
//
// No product code implements this: the guarantee comes from std-32 cl-6, which stamps
// `actor_name` onto the row at write time precisely "so a later user rename or deletion
// never rewrites historical attribution". This test is the REGRESSION GUARD — it exists
// so a future well-meaning backfill (or a switch to a read-time join on users.name)
// can't land unnoticed. dec-4 records that the user explicitly declined such a backfill.
//
// Both directions are asserted. Checking only that the old row keeps the old name would
// also pass if attribution were simply broken and never updating, so the test writes a
// second row AFTER the rename and requires it to carry the NEW name.
const AC_HISTORY = "mindset-prod/memex-building-itself/specs/spec-537/acs/ac-13";

const NAME_BEFORE = "Attribution Before";
const NAME_AFTER = "Attribution After";

// std-37 cl-1: unique per worker AND per call — never a bare Date.now() or a literal.
function uniqueEmail(): string {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `spec537-rename-${worker}-${tail}@example.test`;
}

const createdDocIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // std-37 cl-6: teardown is idempotent and scoped to what this file created.
  if (createdDocIds.length > 0) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

// The attribution snapshot lives on the doc's SECTIONS, not on `documents` itself:
// `documents` carries only `created_by_user_id` (a join key, no denormalised name),
// while createDocDraft stamps `bornAttribution` — {actorUserId, actorName, channel}
// from resolveActorColumns — onto every section it inserts (documents.ts ~L293).
// doc_sections is on std-32's activity-bearing list, so it is the right row to assert.
async function sectionActorNames(docId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ actorName: docSections.actorName })
    .from(docSections)
    .where(eq(docSections.docId, docId));
  return rows.map((r) => r.actorName);
}

describe("spec-537 ac-13: a user rename does not rewrite recorded attribution", () => {
  it("freezes actor_name on rows written before the rename, and uses the new name after", async () => {
    tagAc(AC_HISTORY);

    const { memexId } = await makeTestMemexWithDevAdmin("s537");
    const user = await upsertUserByEmail(uniqueEmail());
    createdUserIds.push(user.id);
    await updateUserProfile(user.id, { name: NAME_BEFORE });

    // Deliberately pass ONLY {actorUserId, channel} — no actorName. That forces
    // resolveActorColumns() to snapshot the name from `users` at write time, which is
    // the exact mechanism ac-13 depends on. A ctx that pre-carried the name would
    // prove less.
    const before = await createDocDraft(
      memexId,
      "Written before the rename",
      "Fixture for spec-537 ac-13.",
      "spec",
      undefined,
      undefined,
      user.id,
      { actorUserId: user.id, channel: "rest_ui" },
    );
    createdDocIds.push(before.id);
    const bornBefore = await sectionActorNames(before.id);
    expect(bornBefore.length).toBeGreaterThan(0);
    expect(new Set(bornBefore)).toEqual(new Set([NAME_BEFORE]));

    // The rename itself — the same service call the profile page's endpoint makes.
    await updateUserProfile(user.id, { name: NAME_AFTER });
    const [renamed] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, user.id));
    expect(renamed?.name).toBe(NAME_AFTER);

    // (1) History is intact — the pre-rename rows still read the old name.
    expect(new Set(await sectionActorNames(before.id))).toEqual(new Set([NAME_BEFORE]));

    // (2) …and attribution is not merely frozen/broken: a new write picks up the
    // new name. Without this half, a totally broken write path would pass (1).
    const after = await createDocDraft(
      memexId,
      "Written after the rename",
      "Fixture for spec-537 ac-13.",
      "spec",
      undefined,
      undefined,
      user.id,
      { actorUserId: user.id, channel: "rest_ui" },
    );
    createdDocIds.push(after.id);
    const bornAfter = await sectionActorNames(after.id);
    expect(bornAfter.length).toBeGreaterThan(0);
    expect(new Set(bornAfter)).toEqual(new Set([NAME_AFTER]));

    // (3) Writing the second doc did not retro-touch the first (no backfill).
    expect(new Set(await sectionActorNames(before.id))).toEqual(new Set([NAME_BEFORE]));
  });
});
