// spec-449: Standards have no status lifecycle — a Standard is in force the moment
// it exists. These tests verify the behavioural claims of the removal:
//   ac-6  standards are born 'approved' on every creation path (Specs stay 'draft')
//   ac-7  the backfill migration normalizes legacy standards → 'approved', idempotent,
//         and scoped to doc_type='standard' (Specs untouched)
//   ac-8  updateDocStatus hard-rejects a status flip on a standard (no-op allowed)
//   ac-9  the shared DOC_STATUSES enum still carries 'draft' + 'approved' (Specs /
//         Execution plans depend on them) — this Spec removes no enum value
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createStandard } from "./standards.js";
import { DOC_STATUSES } from "../types/roles.js";
import { ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-449/acs";

// The real migration, read from disk so the test exercises the shipped SQL.
const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL("../../drizzle/0123_spec449_standards_status_approved.sql", import.meta.url),
  ),
  "utf8",
);

async function statusOf(id: string): Promise<string | undefined> {
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row?.status;
}

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("spec-449 — Standards are born 'approved' (ac-6)", () => {
  it("createStandard (React-UI service path) mints an approved standard", async () => {
    tagAc(`${AC}/ac-6`);
    // scope ac-2: creating a Standard yields a single canonical in-force state.
    tagAc(`${AC}/ac-2`);
    const std = await createStandard(memexId, {
      title: "Born approved via createStandard",
      sections: [{ sectionType: "rule", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    expect(await statusOf(std.id)).toBe("approved");
  });

  it("createDocDraft(docType='standard') mints an approved standard", async () => {
    tagAc(`${AC}/ac-6`);
    const std = await createDocDraft(memexId, "Born approved via createDocDraft", "purpose", "standard");
    createdDocIds.push(std.id);
    expect(await statusOf(std.id)).toBe("approved");
  });

  it("createDocDraft for a Spec is still born 'draft' (change is standards-only)", async () => {
    tagAc(`${AC}/ac-6`);
    const spec = await createDocDraft(memexId, "Control spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    expect(await statusOf(spec.id)).toBe("draft");
  });
});

describe("spec-449 — updateDocStatus guard on Standards (ac-8)", () => {
  it("rejects a status change on a standard and leaves the row unchanged", async () => {
    tagAc(`${AC}/ac-8`);
    const std = await createStandard(memexId, {
      title: "Guarded standard",
      sections: [{ sectionType: "rule", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    expect(await statusOf(std.id)).toBe("approved");

    await expect(updateDocStatus(memexId, std.id, "draft")).rejects.toBeInstanceOf(ValidationError);
    // The row is untouched — no partial write.
    expect(await statusOf(std.id)).toBe("approved");
  });

  it("allows a no-op set (same status) so idempotent callers don't trip", async () => {
    tagAc(`${AC}/ac-8`);
    const std = await createStandard(memexId, {
      title: "No-op standard",
      sections: [{ sectionType: "rule", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    await expect(updateDocStatus(memexId, std.id, "approved")).resolves.toBeTruthy();
    expect(await statusOf(std.id)).toBe("approved");
  });

  it("still lets a Spec change status (the guard is standards-only)", async () => {
    tagAc(`${AC}/ac-8`);
    // scope ac-4: the Spec phase machine + shared documents.status column are untouched.
    tagAc(`${AC}/ac-4`);
    const spec = await createDocDraft(memexId, "Movable spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    const moved = await updateDocStatus(memexId, spec.id, "specify");
    expect(moved.status).toBe("specify");
  });
});

describe("spec-449 — backfill migration normalizes standards (ac-7)", () => {
  // The migration is a GLOBAL update by design, so run it inside a transaction we
  // roll back — the assertions read state before the rollback, and no cross-worker
  // side effect escapes (std-37 isolation).
  class Rollback extends Error {}

  it("flips a legacy draft standard → approved, is idempotent, and leaves Specs alone", async () => {
    tagAc(`${AC}/ac-7`);
    // scope ac-3: existing standards are normalized so none report draft (no manual cleanup).
    tagAc(`${AC}/ac-3`);
    let stdAfterFirst: string | undefined;
    let stdAfterSecond: string | undefined;
    let specAfter: string | undefined;

    try {
      await db.transaction(async (tx) => {
        // A pre-migration standard forced to 'draft' via direct insert (bypassing
        // the born-approved default), plus a draft Spec as the negative control.
        const [std] = await tx
          .insert(documents)
          .values({ memexId, handle: "std-legacy-draft", title: "Legacy draft standard", docType: "standard", status: "draft" })
          .returning();
        const [spec] = await tx
          .insert(documents)
          .values({ memexId, handle: "spec-control", title: "Untouched draft spec", docType: "spec", status: "draft" })
          .returning();

        await tx.execute(sql.raw(MIGRATION_SQL));
        [{ status: stdAfterFirst }] = await tx
          .select({ status: documents.status })
          .from(documents)
          .where(eq(documents.id, std.id));
        [{ status: specAfter }] = await tx
          .select({ status: documents.status })
          .from(documents)
          .where(eq(documents.id, spec.id));

        // Re-run: idempotent no-op.
        await tx.execute(sql.raw(MIGRATION_SQL));
        [{ status: stdAfterSecond }] = await tx
          .select({ status: documents.status })
          .from(documents)
          .where(eq(documents.id, std.id));

        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    expect(stdAfterFirst).toBe("approved"); // normalized
    expect(stdAfterSecond).toBe("approved"); // idempotent
    expect(specAfter).toBe("draft"); // scoped to doc_type='standard'
  });
});

describe("spec-449 — shared status enum left intact (ac-9)", () => {
  it("DOC_STATUSES still contains 'draft' and 'approved' (Specs / Execution plans use them)", () => {
    tagAc(`${AC}/ac-9`);
    expect(DOC_STATUSES).toContain("draft");
    expect(DOC_STATUSES).toContain("approved");
  });
});
