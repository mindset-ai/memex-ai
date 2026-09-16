// spec-566 t-8 — a reopen whose record fails does not happen.
//
// WHY THIS IS ITS OWN FILE, and why it exists at all.
//
// `updateDocStatus` comments that the reopen and its journal row "commit
// together". Nothing in spec-reopen.integration.test.ts could see whether that
// was true: wrapping the journal write in `.catch(() => undefined)` — making it
// exactly the best-effort write this Spec exists to replace — left all five of
// those cases GREEN. An untested claim in a comment is the shape of problem
// spec-566 is about, so this is the instrument that expresses it.
//
// The same probe that caught t-4's vacuous atomicity test, applied to its
// sibling. `vi.mock` is file-scoped, which is why this lives apart.
//
// The property matters because a reopen whose record silently failed is the
// QUIET reopen dec-9's guard exists to prevent: the Spec is open and editable,
// and nothing anywhere says it was reopened or why.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Mocked BEFORE the service under test is imported. Everything else in the
// reopen stays real — the tenancy read, the reason guard, the status write and
// the enclosing transaction all run exactly as in production.
vi.mock("./lifecycle-journal.js", () => ({
  recordLifecycleEvent: vi.fn(async () => {
    throw new Error("simulated reopen journal insert failure");
  }),
}));

const { db } = await import("../db/connection.js");
const { documents, memexes, namespaces } = await import("../db/schema.js");
const { createDocDraft, updateDocStatus } = await import("./documents.js");
const { makeTestMemex } = await import("./test-helpers.js");

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

let memexId: string;
const createdDocIds: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("ratm566");
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

describe("spec-566 t-8 — a reopen whose record fails leaves the Spec closed", () => {
  it("rolls the status back when the journal write throws", async () => {
    tagAc(`${SPEC}/acs/ac-27`);

    const doc = await createDocDraft(memexId, "reopen atomicity fixture", "purpose", "spec");
    createdDocIds.push(doc.id);
    // Closing takes the non-reopen path, so it writes no journal row and the
    // mock above cannot interfere with the setup.
    await updateDocStatus(memexId, doc.id, "done");

    // Precondition: the Spec really is closed, so "it stayed closed" below and
    // "it was never open" are distinguishable.
    const before = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(before!.status).toBe("done");

    await expect(
      updateDocStatus(memexId, doc.id, "verify", {
        reason: "a perfectly good reason",
        ctx: { channel: "mcp" },
      }),
    ).rejects.toThrow(/journal/i);

    // THE claim: the whole act rolled back. This is the property that separates
    // the reopen record from an advisory write — a record permitted to silently
    // not exist is not a record, so the act it accompanies must not stand
    // without it.
    const after = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(after!.status).toBe("done");
  });
});
