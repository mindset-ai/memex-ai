// b-47: regression gate for the handle-allocator branch matrix.
//
// `createDocDraft` mints the per-doc handle when a doc is created. Different
// docTypes use different handle prefixes per std-1 (canonical URL paths):
//
//   - spec                 → `spec-N` (nextSpecHandle)
//   - standard             → `std-N`  (nextStandardHandle)
//   - document             → `doc-N`  (nextDocHandle)
//   - execution_plan       → `doc-N`  (nextDocHandle — execution plans live
//                                       on the doc-N counter; created via
//                                       services/execution_plans.ts)
//   - adr                  → `doc-N`
//   - runbook              → `doc-N`
//
// b-47 root cause: the branch in `createDocDraft` only special-cased 'spec';
// the 'standard' case fell through to `nextDocHandle` and minted `doc-N`
// handles for Standards rows created via the MCP `create_doc` tool. The
// resulting rows are unreachable through the canonical-ref validator
// (`resolveRef` rejects `standards/doc-N` — expects `std-N`).
//
// This test exercises the service-layer creation path for every docType the
// branch covers and asserts the handle's prefix matches the docType. A single
// test covers the matrix; future drift in any branch fails here.
//
// Note: `createStandard` (in services/standards.ts) has its own creation
// path used by the React UI Standards flow — it routes through
// `nextStandardHandle` directly. This test covers `createDocDraft` because
// that's the path MCP `create_doc` takes for all docTypes (including
// 'standard'), which is where the b-47 regression actually surfaced.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
  users: [] as string[],
};

afterAll(async () => {
  if (cleanup.memexes.length) {
    await db.delete(docComments).where(inArray(docComments.memexId, cleanup.memexes)).catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, cleanup.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

describe("regression: createDocDraft mints the correct handle prefix per docType (b-47)", () => {
  let memexId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("b47");
    cleanup.memexes.push(memexId);
  });

  // The matrix: docType → expected handle prefix.
  //
  // - 'spec'           → `spec-N` (typed; b-105)
  // - 'standard'       → `std-N`  (typed; std-1; b-47 fix)
  // - 'document'       → `doc-N`  (generic)
  // - 'execution_plan' → `doc-N`  (generic; execution plans share the doc-N counter)
  // - 'adr'            → `doc-N`  (generic)
  // - 'runbook'        → `doc-N`  (generic)
  const cases: Array<{ docType: string; prefix: string }> = [
    { docType: "spec", prefix: "spec-" },
    { docType: "standard", prefix: "std-" },
    { docType: "document", prefix: "doc-" },
    { docType: "execution_plan", prefix: "doc-" },
    { docType: "adr", prefix: "doc-" },
    { docType: "runbook", prefix: "doc-" },
  ];

  for (const { docType, prefix } of cases) {
    it(`docType='${docType}' mints a handle with prefix '${prefix}'`, async () => {
      const result = await createDocDraft(
        memexId,
        `Test ${docType}`,
        `Purpose for ${docType}`,
        docType,
      );
      cleanup.docs.push(result.id);

      expect(result.handle).toMatch(new RegExp(`^${prefix.replace("-", "\\-")}\\d+$`));
      expect(result.docType).toBe(docType);
    });
  }
});
