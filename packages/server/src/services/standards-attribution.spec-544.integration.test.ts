// spec-544 dec-1 — repo attribution is a SET of flat tags on a Standard, and the
// two never displace each other.
//
// WHY THIS RUNS AGAINST A REAL DATABASE. The claim is about persistence, and the
// failure it guards against is a storage-shape one: a scoped tag (`repo::x`) is
// mutually exclusive within its scope, so applying `repo::memex-clients` to a
// Standard already carrying `repo::memex-ai` DROPS the first. dec-1 chose flat
// labels (scope NULL) precisely because the both-repos set is a dozen Standards
// and a single-valued attribute is the wrong shape for it. Nothing but a real
// write-then-read proves the flat form actually coexists — a mock would encode
// whichever behaviour the author assumed.
//
// This also closes the honesty gap the spec-544 build carried for a while: tag
// coexistence was OBSERVED on live prod data ("tagged memex-ai, memex-clients")
// but no tagged test asserted it, so Memex was right to keep counting ac-12
// unverified however convincing the observation looked.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, documentTags, users } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { applyTagString, listDocTags, removeTagString } from "./tags.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import type { RequestCtx } from "./mutate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-544";
const AC_12 = `${SPEC}/acs/ac-12`;
const AC_13 = `${SPEC}/acs/ac-13`;

const AI = "memex-ai";
const CLIENTS = "memex-clients";

// The channel a real attribution write arrives on: `update_doc` over MCP.
const ctx: RequestCtx = { channel: "mcp" };

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  ({ memexId } = await makeTestMemexWithDevAdmin("spec544attr"));
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db
      .delete(documents)
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
  }
});

async function newStandard(title: string): Promise<string> {
  const std = await createStandard(memexId, {
    title,
    description: "Seeded by the spec-544 attribution integration test.",
    sections: [{ sectionType: "rule", content: "A rule body." }],
  });
  createdDocIds.push(std.id);
  return std.id;
}

const valuesOf = async (docId: string) =>
  (await listDocTags(memexId, docId)).map((t) => t.value).sort();

describe("spec-544: attribution tags coexist on a Standard (ac-12)", () => {
  it("stores them FLAT — scope is NULL, not a repo:: group", async () => {
    tagAc(AC_12);
    const docId = await newStandard("Flat storage");

    const applied = await applyTagString(ctx, memexId, docId, AI);

    expect(
      applied.scope,
      "A scoped tag is mutually exclusive within its scope, which is exactly how " +
        "a both-repos Standard would lose half its attribution. Flat means NULL scope.",
    ).toBeNull();
    expect(applied.value).toBe(AI);
  });

  it("adding the second attribution does NOT displace the first", async () => {
    tagAc(AC_12);
    const docId = await newStandard("Binds both repos");

    await applyTagString(ctx, memexId, docId, AI);
    await applyTagString(ctx, memexId, docId, CLIENTS);

    expect(
      await valuesOf(docId),
      `Both attributions must survive. If this returns one value, the tag has ` +
        `acquired scope semantics and every Standard binding both repos has ` +
        `silently halved its attribution.`,
    ).toEqual([AI, CLIENTS].sort());
  });

  it("holds in the REVERSE order too — neither value is privileged", async () => {
    tagAc(AC_12);
    const docId = await newStandard("Binds both, applied backwards");

    await applyTagString(ctx, memexId, docId, CLIENTS);
    await applyTagString(ctx, memexId, docId, AI);

    expect(await valuesOf(docId)).toEqual([AI, CLIENTS].sort());
  });

  it("narrows back to one when an attribution is removed", async () => {
    tagAc(AC_12);
    const docId = await newStandard("Narrowed later");

    await applyTagString(ctx, memexId, docId, AI);
    await applyTagString(ctx, memexId, docId, CLIENTS);
    await removeTagString(ctx, memexId, docId, CLIENTS);

    // Removing one leaves the other — the set shrinks, it does not empty. An
    // empty result here would read as "unattributed" downstream and, under
    // dec-2's fail-open, put the Standard back into EVERY repo's index.
    expect(await valuesOf(docId)).toEqual([AI]);
  });

  it("is idempotent — applying the same attribution twice adds one link", async () => {
    tagAc(AC_12);
    const docId = await newStandard("Applied twice");

    await applyTagString(ctx, memexId, docId, AI);
    await applyTagString(ctx, memexId, docId, AI);

    expect(
      (await listDocTags(memexId, docId)).filter((t) => t.value === AI),
      "A re-run of the attribution job must not accumulate duplicate links.",
    ).toHaveLength(1);
  });
});

describe("spec-544: a Standard takes tags exactly as a Spec does (ac-13)", () => {
  it("accepts the write on a docType='standard' document and reads it back", async () => {
    tagAc(AC_13);
    const docId = await newStandard("Standards are taggable");

    // The write path has no docType gate — `update_doc`'s only ref check is
    // isDocLikeKind — even though every tag description in the product says
    // "Spec". That wording is stale copy, not enforcement, and this is the test
    // that would notice if a gate were ever added and quietly broke attribution.
    await expect(applyTagString(ctx, memexId, docId, AI)).resolves.toBeTruthy();
    expect(await valuesOf(docId)).toEqual([AI]);
  });

  it("stamps WHO applied the attribution, and refuses a non-existent actor (std-32)", async () => {
    tagAc(AC_13);
    const docId = await newStandard("Attributed by someone");

    // `document_tags.added_by` carries an FK to `users`, which is STRICTER than
    // std-32 asks for: attribution cannot name an actor who does not exist, so
    // the WHO on a tag link can never be a plausible-looking fiction. Pinned
    // here because it is a real guarantee worth not losing — a fabricated uuid
    // fails with 23503 rather than persisting.
    await expect(
      applyTagString(ctx, memexId, docId, AI, "00000000-0000-4000-8000-000000000544"),
      "a fabricated actor must be refused by the FK, not stored",
    ).rejects.toThrow();

    const [someone] = await db.select({ id: users.id }).from(users).limit(1);
    if (!someone) {
      throw new Error(
        "no user row in the test database — this assertion needs a real actor, " +
          "because added_by is FK-constrained to users",
      );
    }
    const actor = someone.id;

    await applyTagString(ctx, memexId, docId, AI, actor);

    // std-32: an activity-bearing row carries WHO, stamped at write. `added_by`
    // lives on the LINK (`document_tags`), not on the catalogue tag — a tag is
    // shared by every document that carries it, so it cannot hold who applied
    // any one of them. Read the link row rather than trusting a call that
    // returned without throwing.
    const links = await db
      .select({ addedBy: documentTags.addedBy })
      .from(documentTags)
      .where(eq(documentTags.docId, docId));

    expect(links).toHaveLength(1);
    expect(
      links[0].addedBy,
      "attribution without an actor is history nobody can audit",
    ).toBe(actor);
  });

  it("is case-insensitive on the tag identity, so a retype cannot fork it", async () => {
    tagAc(AC_13);
    const docId = await newStandard("Case folded");

    await applyTagString(ctx, memexId, docId, AI);
    await applyTagString(ctx, memexId, docId, "Memex-AI");

    // The 0125 CI unique index (NULLS NOT DISTINCT) guarantees one canonical row,
    // so an agent naming the repo in different casing cannot mint a second
    // attribution that the index generator would then fail to match.
    expect(await valuesOf(docId)).toEqual([AI]);
  });
});
