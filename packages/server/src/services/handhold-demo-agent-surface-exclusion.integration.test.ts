// spec-178 ac-42 (dec-11) — is_demo content is excluded from the embedding and
// standards-drift agent surfaces.
//
// This is both a dec-11 correctness guarantee (demo specs are off every agent
// surface, and embeddings + drift are agent surfaces) AND the load-bearing fix
// for the existing-Memex backfill: scanForDecisionDrift is AWAITED on the
// resolveDecision path (a standards FTS per resolve), so seeding 5×N demo specs
// would otherwise put N× full drift scans on the critical path and stall the
// deploy (the spec-178 backfill incident). Both arms run against real Postgres.
//
//   embed arm:  embedAndStoreSection / embedAndStoreDecision return 'skipped-demo'
//               for a doc with is_demo=true, BEFORE the provider check — and a
//               non-demo section/decision does NOT get that status.
//   drift arm:  resolving a DEMO decision posts no drift comment on a standard
//               that references its handle, while resolving a NON-DEMO decision
//               with the identical setup DOES — proving the resolveDecision guard.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { docSections, documents, docComments, memexes, namespaces } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { embedAndStoreSection, embedAndStoreDecision } from "./memex-embeddings.js";

const AC_42 = "mindset-prod/memex-building-itself/specs/spec-178/acs/ac-42";

const createdMemexIds: string[] = [];

beforeAll(async () => {
  // two memexes: one drives the demo arm, one the non-demo control for drift.
  const a = await makeTestMemexWithDevAdmin("ac42a");
  const b = await makeTestMemexWithDevAdmin("ac42b");
  createdMemexIds.push(a.memexId, b.memexId);
  memexDemo = a.memexId;
  memexControl = b.memexId;
});

let memexDemo: string;
let memexControl: string;

afterAll(async () => {
  const docRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.memexId, createdMemexIds))
    .catch(() => [] as { id: string }[]);
  const docIds = docRows.map((r) => r.id);
  if (docIds.length) {
    await db.delete(docSections).where(inArray(docSections.docId, docIds)).catch(() => {});
  }
  await db.delete(documents).where(inArray(documents.memexId, createdMemexIds)).catch(() => {});
  const memexRows = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(inArray(memexes.id, createdMemexIds))
    .catch(() => [] as { namespaceId: string }[]);
  await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  const namespaceIds = memexRows.map((r) => r.namespaceId);
  if (namespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds)).catch(() => {});
  }
});

describe("ac-42: is_demo content is never embedded", () => {
  it("embedAndStoreSection/Decision return 'skipped-demo' for a demo doc, not for a real one", async () => {
    tagAc(AC_42);

    // Demo doc — created with is_demo at creation (the real seed path).
    const demo = await createDocDraft(memexDemo, "Demo embed", "Demo overview.", "spec", undefined, {
      isDemo: true,
    });
    const demoSection = await addSection(memexDemo, demo.id, "scope", "demo scope content");
    const demoDecision = await createDecision(memexDemo, demo.id, "Demo decision", "ctx");

    const demoSectionResult = await embedAndStoreSection(demoSection.id, { memexId: memexDemo });
    const demoDecisionResult = await embedAndStoreDecision(demoDecision.id, { memexId: memexDemo });
    expect(demoSectionResult.status).toBe("skipped-demo");
    expect(demoDecisionResult.status).toBe("skipped-demo");

    // Real doc — must NOT be treated as demo (guard is is_demo-specific, not a
    // blanket skip). In the test env there is no embedding provider, so a real
    // section/decision returns 'skipped-no-provider' — the point is it is NOT
    // 'skipped-demo'.
    const real = await createDocDraft(memexDemo, "Real embed", "Real overview.", "spec");
    const realSection = await addSection(memexDemo, real.id, "scope", "real scope content");
    const realDecision = await createDecision(memexDemo, real.id, "Real decision", "ctx");

    const realSectionResult = await embedAndStoreSection(realSection.id, { memexId: memexDemo });
    const realDecisionResult = await embedAndStoreDecision(realDecision.id, { memexId: memexDemo });
    expect(realSectionResult.status).not.toBe("skipped-demo");
    expect(realDecisionResult.status).not.toBe("skipped-demo");
  });
});

describe("ac-42: resolving a demo decision does not run the standards drift scan", () => {
  // Build a standard section that references `[per dec-1]` and a spec whose first
  // decision is dec-1, then resolve that decision. A non-demo decision posts a
  // drift comment on the standard; a demo decision must post none.
  async function setup(memexId: string, isDemo: boolean): Promise<string> {
    // Standard with a clause that references the decision handle.
    const std = await createDocDraft(memexId, "Drift standard", "std purpose", "standard");
    const stdSection = await addSection(
      memexId,
      std.id,
      "do",
      "Deploys must follow the rule [per dec-1].",
    );
    // Spec whose first decision becomes dec-1 (seq is per-doc).
    const spec = await createDocDraft(memexId, "Drift spec", "spec overview", "spec", undefined, {
      isDemo,
    });
    const decision = await createDecision(memexId, spec.id, "Choose the deploy rule", "ctx");
    expect(decision.seq).toBe(1); // referenced as [per dec-1] above
    await resolveDecision(memexId, decision.id, "Resolved: use the rule.");
    return stdSection.id;
  }

  it("a NON-DEMO decision posts a drift comment (control)", async () => {
    tagAc(AC_42);
    const stdSectionId = await setup(memexControl, /* isDemo */ false);
    const drift = await db.query.docComments.findMany({
      where: and(eq(docComments.sectionId, stdSectionId), eq(docComments.commentType, "drift")),
    });
    expect(drift.length).toBeGreaterThanOrEqual(1);
  });

  it("a DEMO decision posts NO drift comment (the spec-178 fix)", async () => {
    tagAc(AC_42);
    const stdSectionId = await setup(memexDemo, /* isDemo */ true);
    const drift = await db.query.docComments.findMany({
      where: and(eq(docComments.sectionId, stdSectionId), eq(docComments.commentType, "drift")),
    });
    expect(drift).toHaveLength(0);
  });
});
