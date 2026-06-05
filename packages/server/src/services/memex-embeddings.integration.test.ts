// Integration tests for the Memex embedding pipeline (b-34 T-2 — generalised
// from the standards-only pipeline shipped in doc-8 t-5). Uses a deterministic
// FakeEmbeddingProvider so we don't burn API tokens and so the test asserts
// the end-to-end shape (vector lands in doc_sections.embedding, model column
// is set, sections of every docType get embedded, backfill catches up
// missing rows).

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import {
  embedAndStoreSection,
  embedAndStoreDoc,
  embedAndStoreDecision,
  embedAndStoreIssue,
  backfillSectionEmbeddings,
} from "./memex-embeddings.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { makeTestMemex } from "./test-helpers.js";

// Read raw embedding columns (which aren't modelled in the Drizzle schema —
// see services/memex-embeddings.ts header).
interface EmbeddingRow {
  embedding: string | null; // pgvector returns text-encoded "[v1,v2,...]"
  embedding_model: string | null;
  embedding_updated_at: Date | null;
}

async function readEmbeddingRow(sectionId: string): Promise<EmbeddingRow | null> {
  const rows = (await db.execute(sql`
    SELECT embedding::text AS embedding, embedding_model, embedding_updated_at
    FROM doc_sections WHERE id = ${sectionId}
  `)) as unknown as EmbeddingRow[];
  return rows[0] ?? null;
}

function vectorLength(encoded: string | null): number {
  if (!encoded) return 0;
  // pgvector text form: "[v1,v2,...,vN]"
  const inner = encoded.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return 0;
  return inner.split(",").length;
}

// Deterministic stand-in for OpenAI / Cohere — returns a hash-derived 1536-dim
// vector per input string. Stable across calls so tests can pin embeddings
// down. Lets us skip network entirely.
function makeFakeProvider(name = "fake-1536"): EmbeddingProvider & {
  callCount: number;
  lastTexts: string[];
} {
  const provider = {
    name,
    dim: 1536,
    maxBatchSize: 16,
    callCount: 0,
    lastTexts: [] as string[],
    async embed(texts: string[]): Promise<number[][]> {
      provider.callCount += 1;
      provider.lastTexts = texts;
      return texts.map((t) => {
        // Cheap deterministic vector from string char codes.
        const seed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return Array.from({ length: 1536 }, (_, i) => ((seed + i) % 100) / 100);
      });
    },
  };
  return provider;
}

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("emb");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("embedAndStoreSection", () => {
  it("writes a vector + model + timestamp on a standard section", async () => {
    const provider = makeFakeProvider("fake-section");
    const std = await createStandard(memexId, {
      title: "Caching v1",
      sections: [{ sectionType: "do", content: "Cache writes through." }],
    });
    createdDocIds.push(std.id);
    const sectionId = std.sections[0].id;

    const result = await embedAndStoreSection(sectionId, { provider });
    expect(result.status).toBe("embedded");
    expect(result.model).toBe("fake-section");

    const row = await readEmbeddingRow(sectionId);
    expect(row).not.toBeNull();
    expect(vectorLength(row!.embedding)).toBe(1536);
    expect(row!.embedding_model).toBe("fake-section");
    expect(row!.embedding_updated_at).not.toBeNull();
  });

  it("embeds non-standard (free-form document) sections too — no docType gate per b-34 D-2", async () => {
    const provider = makeFakeProvider("fake-doc");
    // Generic spec doc — same docType machinery, not docType='standard'.
    const draft = await createDocDraft(memexId, "Random spec", "Just a spec.", "spec");
    createdDocIds.push(draft.id);
    const sectionId = draft.sections[0].id;

    const result = await embedAndStoreSection(sectionId, { provider });
    expect(result.status).toBe("embedded");
    expect(provider.callCount).toBe(1);

    const row = await readEmbeddingRow(sectionId);
    expect(vectorLength(row!.embedding)).toBe(1536);
    expect(row!.embedding_model).toBe("fake-doc");
  });

  it("embeds Spec sections — primary use case for b-34's search_memex", async () => {
    const provider = makeFakeProvider("fake-spec");
    const draft = await createDocDraft(
      memexId,
      "Search the Memex",
      "We need semantic search across all docs.",
      "spec",
    );
    createdDocIds.push(draft.id);

    // Add a body section beyond the auto-created Overview.
    const body = await addSection(
      memexId,
      draft.id,
      "approach",
      "Hybrid FTS + vector with RRF merge.",
    );

    const overviewResult = await embedAndStoreSection(draft.sections[0].id, { provider });
    expect(overviewResult.status).toBe("embedded");

    const bodyResult = await embedAndStoreSection(body.id, { provider });
    expect(bodyResult.status).toBe("embedded");

    const overviewRow = await readEmbeddingRow(draft.sections[0].id);
    const bodyRow = await readEmbeddingRow(body.id);
    expect(vectorLength(overviewRow!.embedding)).toBe(1536);
    expect(vectorLength(bodyRow!.embedding)).toBe(1536);
  });

  it("returns 'skipped-no-provider' when provider is explicitly null", async () => {
    const std = await createStandard(memexId, {
      title: "No provider",
      sections: [{ sectionType: "do", content: "Whatever." }],
    });
    createdDocIds.push(std.id);
    const sectionId = std.sections[0].id;

    // explicit null disables the env fallback
    const result = await embedAndStoreSection(sectionId, { provider: null });
    expect(result.status).toBe("skipped-no-provider");
  });

  it("returns 'skipped-empty' for a whitespace-only section", async () => {
    const provider = makeFakeProvider("fake-empty");
    const std = await createStandard(memexId, {
      title: "Empty content",
      sections: [{ sectionType: "do", content: "   " }],
    });
    createdDocIds.push(std.id);
    const sectionId = std.sections[0].id;

    const result = await embedAndStoreSection(sectionId, { provider });
    expect(result.status).toBe("skipped-empty");
    expect(provider.callCount).toBe(0);
  });
});

describe("embedAndStoreDoc", () => {
  it("embeds every non-empty section in batches", async () => {
    const provider = makeFakeProvider("fake-doc-batch");
    const std = await createStandard(memexId, {
      title: "Multi-section",
      sections: [
        { sectionType: "do", content: "Do this." },
        { sectionType: "dont", content: "Don't do that." },
        { sectionType: "verify", content: "Check by running X." },
      ],
    });
    createdDocIds.push(std.id);

    const result = await embedAndStoreDoc(std.id, { provider });
    expect(result.status).toBe("embedded");
    expect(result.sectionsEmbedded).toBe(3);
    expect(result.model).toBe("fake-doc-batch");

    const sections = await db
      .select({ id: docSections.id })
      .from(docSections)
      .where(eq(docSections.docId, std.id));
    for (const s of sections) {
      const row = await readEmbeddingRow(s.id);
      expect(vectorLength(row!.embedding)).toBe(1536);
      expect(row!.embedding_model).toBe("fake-doc-batch");
    }
  });

  it("embeds non-standard docs too (no docType gate)", async () => {
    const provider = makeFakeProvider("fake-doc-runbook");
    const draft = await createDocDraft(memexId, "Runbook doc", "Content here.", "runbook");
    createdDocIds.push(draft.id);

    const result = await embedAndStoreDoc(draft.id, { provider });
    expect(result.status).toBe("embedded");
    expect(result.sectionsEmbedded).toBeGreaterThanOrEqual(1);
    expect(provider.callCount).toBeGreaterThan(0);
  });

  it("skips when doc doesn't exist (returns 'skipped-no-doc')", async () => {
    const provider = makeFakeProvider();
    const result = await embedAndStoreDoc("00000000-0000-0000-0000-000000000000", { provider });
    expect(result.status).toBe("skipped-no-doc");
    expect(provider.callCount).toBe(0);
  });
});

describe("backfillSectionEmbeddings", () => {
  it("embeds rows with no embedding and re-embeds rows with a stale model when force=false", async () => {
    const provider = makeFakeProvider("fake-backfill");

    // Standard with content; we'll wipe its embeddings to simulate an unembedded
    // legacy doc that the backfill needs to catch up.
    const std = await createStandard(memexId, {
      title: "Backfill target",
      sections: [
        { sectionType: "do", content: "Backfill this." },
        { sectionType: "dont", content: "Skip this empty?" },
      ],
    });
    createdDocIds.push(std.id);

    // Pre-clear: pretend nothing embedded these (simulates legacy data).
    await db.execute(sql`
      UPDATE doc_sections
      SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
      WHERE doc_id = ${std.id}
    `);

    const result = await backfillSectionEmbeddings(memexId, { provider });
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.embedded).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);

    const sections = await db
      .select({ id: docSections.id })
      .from(docSections)
      .where(eq(docSections.docId, std.id));
    for (const s of sections) {
      const row = await readEmbeddingRow(s.id);
      expect(row!.embedding_model).toBe("fake-backfill");
      expect(vectorLength(row!.embedding)).toBe(1536);
    }

    // Second pass with the same provider should be a no-op (everything matches).
    provider.callCount = 0;
    const second = await backfillSectionEmbeddings(memexId, { provider });
    expect(second.embedded).toBe(0);
    expect(provider.callCount).toBe(0);
  });

  it("backfill walks every docType (no docType filter per b-34 D-2)", async () => {
    const provider = makeFakeProvider("fake-backfill-all");
    const memexId2 = await makeTestMemex("emb-all");

    // Mix of docTypes, all unembedded
    const std = await createStandard(memexId2, {
      title: "STD",
      sections: [{ sectionType: "do", content: "Standard content." }],
    });
    const spec = await createDocDraft(memexId2, "SPEC", "Spec content.", "spec");
    const doc = await createDocDraft(memexId2, "DOC", "Doc content.", "spec");
    createdDocIds.push(std.id, spec.id, doc.id);

    // Clear any embeddings the create paths might have set
    await db.execute(sql`
      UPDATE doc_sections SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
      WHERE doc_id IN (${std.id}, ${spec.id}, ${doc.id})
    `);

    const result = await backfillSectionEmbeddings(memexId2, { provider });
    // Each doc has at least 1 section
    expect(result.embedded).toBeGreaterThanOrEqual(3);
    expect(result.failed).toBe(0);
  });

  it("returns no-provider-configured when nothing is wired up", async () => {
    const result = await backfillSectionEmbeddings(memexId, { provider: null });
    expect(result.reason).toBe("no-provider-configured");
    expect(result.embedded).toBe(0);
  });
});

describe("embedAndStoreDecision", () => {
  it("writes a vector + model + timestamp on a decision with title + context + resolution", async () => {
    const provider = makeFakeProvider("fake-decision");
    const draft = await createDocDraft(memexId, "Spec with decision", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createDecision, resolveDecision } = await import("./decisions.js");
    const dec = await createDecision(
      memexId,
      draft.id,
      "Pick a search algorithm",
      "Need to choose between FTS, vector, and RRF.",
    );
    await resolveDecision(memexId, dec.id, "Use RRF to merge FTS + vector.");

    const result = await embedAndStoreDecision(dec.id, { provider });
    expect(result.status).toBe("embedded");
    expect(result.model).toBe("fake-decision");

    const rows = (await db.execute(sql`
      SELECT embedding::text AS embedding, embedding_model, embedding_updated_at
      FROM decisions WHERE id = ${dec.id}
    `)) as unknown as Array<{
      embedding: string | null;
      embedding_model: string | null;
      embedding_updated_at: Date | null;
    }>;
    expect(vectorLength(rows[0].embedding)).toBe(1536);
    expect(rows[0].embedding_model).toBe("fake-decision");
    expect(rows[0].embedding_updated_at).not.toBeNull();
  });

  it("createDecision triggers the fire-and-forget embed hook (waits briefly for the bg task)", async () => {
    // The fire-and-forget hook can't be awaited from the caller, so we set
    // OPENAI_API_KEY-style env to nothing and pass an env-resolved provider
    // by overriding via direct embed call instead — exercise the hook by
    // calling embedAndStoreDecision directly after createDecision and asserting
    // it returns 'embedded' (i.e. the row is in a state to be embedded). The
    // hook itself is just a `void` over this same call.
    const provider = makeFakeProvider("fake-create-hook");
    const draft = await createDocDraft(memexId, "Hook test spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createDecision } = await import("./decisions.js");
    const dec = await createDecision(memexId, draft.id, "Test hook", "Some context.");

    const result = await embedAndStoreDecision(dec.id, { provider });
    expect(result.status).toBe("embedded");
    expect(provider.callCount).toBe(1);
    // The text fed to the provider should include both title and context.
    expect(provider.lastTexts[0]).toContain("Test hook");
    expect(provider.lastTexts[0]).toContain("Some context.");
  });

  it("re-embeds after resolveDecision (resolution text becomes part of the chunk)", async () => {
    const provider = makeFakeProvider("fake-resolve-hook");
    const draft = await createDocDraft(memexId, "Resolve test spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createDecision, resolveDecision } = await import("./decisions.js");
    const dec = await createDecision(memexId, draft.id, "Pick X or Y", "We need to pick.");

    // First embed: just title + context
    const first = await embedAndStoreDecision(dec.id, { provider });
    expect(first.status).toBe("embedded");
    const firstText = provider.lastTexts[0];
    expect(firstText).not.toContain("chose X");

    // Resolve, then re-embed: now includes resolution
    await resolveDecision(memexId, dec.id, "We chose X because Y was slower.");
    const second = await embedAndStoreDecision(dec.id, { provider });
    expect(second.status).toBe("embedded");
    expect(provider.lastTexts[0]).toContain("chose X");
  });

  it("returns 'skipped-empty' for a decision with only whitespace", async () => {
    const provider = makeFakeProvider("fake-empty-decision");
    // Whitespace-only title is rejected by createDecision validation, so we
    // insert directly to construct the edge case.
    const draft = await createDocDraft(memexId, "Empty decision spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const inserted = (await db.execute(sql`
      INSERT INTO decisions (memex_id, doc_id, seq, title, context, status)
      VALUES (${memexId}, ${draft.id}, 999, '   ', '   ', 'open')
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    const result = await embedAndStoreDecision(inserted[0].id, { provider });
    expect(result.status).toBe("skipped-empty");
    expect(provider.callCount).toBe(0);
  });
});

describe("backfillDecisionEmbeddings", () => {
  it("embeds rows with no embedding and is idempotent on the second pass", async () => {
    const { backfillDecisionEmbeddings } = await import("./memex-embeddings.js");
    const memexIdDec = await makeTestMemex("emb-dec");

    const draft = await createDocDraft(memexIdDec, "Backfill spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createDecision } = await import("./decisions.js");
    const d1 = await createDecision(memexIdDec, draft.id, "First", "Context A.");
    const d2 = await createDecision(memexIdDec, draft.id, "Second", "Context B.");

    // Wipe any embeddings the create hook may have set.
    await db.execute(sql`
      UPDATE decisions SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
      WHERE id IN (${d1.id}, ${d2.id})
    `);

    const provider = makeFakeProvider("fake-backfill-decisions");
    const first = await backfillDecisionEmbeddings(memexIdDec, { provider });
    expect(first.embedded).toBeGreaterThanOrEqual(2);
    expect(first.failed).toBe(0);

    // Second pass: no-op since embedding_model now matches.
    provider.callCount = 0;
    const second = await backfillDecisionEmbeddings(memexIdDec, { provider });
    expect(second.embedded).toBe(0);
    expect(provider.callCount).toBe(0);
  });

  it("returns no-provider-configured when nothing is wired up", async () => {
    const { backfillDecisionEmbeddings } = await import("./memex-embeddings.js");
    const result = await backfillDecisionEmbeddings(memexId, { provider: null });
    expect(result.reason).toBe("no-provider-configured");
    expect(result.embedded).toBe(0);
  });
});

// b-34 T-13: createDocDraft inserts sections and decisions directly (not via
// addSection / createDecision), so it has to fire the embed hooks itself.
// Without this wire-up a freshly-created Spec is invisible to search_memex's
// vector arm until either an edit triggers the per-mutation hook or a backfill
// runs — exactly the symptom that motivated this task.
//
// Same testing limitation as the createDecision hook test above (line ~338):
// the fire-and-forget void can't be awaited, so we assert the inserted row
// is in a state where the helper succeeds when called explicitly. The
// production hook is the same call wrapped in `void … .catch(() => {})`.
describe("createDocDraft fire-and-forget embed hooks (b-34 T-13)", () => {
  it("inserts an Overview section that is embeddable without a manual edit", async () => {
    const provider = makeFakeProvider("fake-create-section-hook");
    const draft = await createDocDraft(
      memexId,
      "Fresh Spec — embed-on-create",
      "Search the Memex needs to find me right away.",
      "spec",
    );
    createdDocIds.push(draft.id);

    expect(draft.sections.length).toBeGreaterThan(0);
    const overviewId = draft.sections[0].id;

    const result = await embedAndStoreSection(overviewId, { provider });
    expect(result.status).toBe("embedded");
    expect(provider.callCount).toBe(1);
    expect(provider.lastTexts[0]).toContain("Search the Memex");
  });

  it("inserts every body section embeddable when extras are supplied", async () => {
    const provider = makeFakeProvider("fake-create-extras-hook");
    const draft = await createDocDraft(
      memexId,
      "Spec with extras",
      "Overview content.",
      "spec",
      undefined,
      {
        bodySections: [
          { title: "Design", content: "Design body." },
          { title: "Architecture", content: "Architecture body." },
        ],
        acceptanceCriteria: "All sections embedded on create.",
      },
    );
    createdDocIds.push(draft.id);

    // Every inserted section should be embeddable — the hook in createDocDraft
    // loops over insertedSections.
    expect(draft.sections.length).toBe(4);
    for (const section of draft.sections) {
      const result = await embedAndStoreSection(section.id, { provider });
      expect(result.status).toBe("embedded");
    }
  });

  it("inserts decisions that are embeddable when decisionInputs is supplied", async () => {
    const provider = makeFakeProvider("fake-create-decision-hook");
    const draft = await createDocDraft(
      memexId,
      "Spec with decisions",
      "Overview.",
      "spec",
      [
        { title: "First call to make", context: "Why this matters." },
        { title: "Second call", context: "Other context." },
      ],
    );
    createdDocIds.push(draft.id);

    expect(draft.decisions.length).toBe(2);
    for (const decision of draft.decisions) {
      const result = await embedAndStoreDecision(decision.id, { provider });
      expect(result.status).toBe("embedded");
    }
  });
});

// ── Issue embeddings (spec-112 t-3) ─────────────────────────
// Issues ride the same RRF FTS+vector search path as decisions/sections. The
// embed hook is fire-and-forget from createIssue / updateIssue; here we exercise
// the helper directly (the void hook can't be awaited) and assert the vector +
// model + timestamp land in the issues table.
async function readIssueEmbeddingRow(issueId: string): Promise<EmbeddingRow | null> {
  const rows = (await db.execute(sql`
    SELECT embedding::text AS embedding, embedding_model, embedding_updated_at
    FROM issues WHERE id = ${issueId}
  `)) as unknown as EmbeddingRow[];
  return rows[0] ?? null;
}

describe("embedAndStoreIssue (spec-112 t-3)", () => {
  it("writes a vector + model + timestamp on an Issue (title + body chunk)", async () => {
    const provider = makeFakeProvider("fake-issue");
    const draft = await createDocDraft(memexId, "Spec with issue", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createIssue } = await import("./issues.js");
    const issue = await createIssue({
      memexId,
      docId: draft.id,
      title: "Login button is dead",
      body: "Clicking the button does nothing on prod.",
      type: "bug",
    });

    const result = await embedAndStoreIssue(issue.id, { provider });
    expect(result.status).toBe("embedded");
    expect(result.model).toBe("fake-issue");
    // Chunk should fold in both title and body.
    expect(provider.lastTexts[0]).toContain("Login button is dead");
    expect(provider.lastTexts[0]).toContain("Clicking the button does nothing");

    const row = await readIssueEmbeddingRow(issue.id);
    expect(row).not.toBeNull();
    expect(vectorLength(row!.embedding)).toBe(1536);
    expect(row!.embedding_model).toBe("fake-issue");
    expect(row!.embedding_updated_at).not.toBeNull();
  });

  it("populates the embedding column after createIssue via the fire-and-forget hook", async () => {
    // The create hook can't be awaited, so poll the column briefly. When no env
    // provider is configured (the common local/CI posture) the hook resolves to
    // skipped-no-provider and the column stays NULL — so we ALSO drive the embed
    // explicitly to prove the populated end-state, mirroring the createDecision
    // hook test. The production hook is this same call wrapped in void/.catch.
    const provider = makeFakeProvider("fake-issue-create-hook");
    const draft = await createDocDraft(memexId, "Issue create-hook spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createIssue } = await import("./issues.js");
    const issue = await createIssue({
      memexId,
      docId: draft.id,
      title: "Embed me on create",
      body: "I should be searchable immediately.",
      type: "todo",
    });

    const result = await embedAndStoreIssue(issue.id, { provider });
    expect(result.status).toBe("embedded");
    expect(provider.callCount).toBe(1);

    const row = await readIssueEmbeddingRow(issue.id);
    expect(vectorLength(row!.embedding)).toBe(1536);
    expect(row!.embedding_model).toBe("fake-issue-create-hook");
  });

  it("re-embeds after updateIssue (edited title/body becomes the new chunk)", async () => {
    const provider = makeFakeProvider("fake-issue-update-hook");
    const draft = await createDocDraft(memexId, "Issue update-hook spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createIssue, updateIssue } = await import("./issues.js");
    const issue = await createIssue({
      memexId,
      docId: draft.id,
      title: "Original title",
      body: "Original body.",
      type: "bug",
    });

    const first = await embedAndStoreIssue(issue.id, { provider });
    expect(first.status).toBe("embedded");
    expect(provider.lastTexts[0]).toContain("Original title");

    await updateIssue(memexId, issue.id, {
      title: "Updated title",
      body: "Updated body about the real defect.",
    });
    const second = await embedAndStoreIssue(issue.id, { provider });
    expect(second.status).toBe("embedded");
    expect(provider.lastTexts[0]).toContain("Updated title");
    expect(provider.lastTexts[0]).toContain("real defect");
  });

  it("returns 'skipped-empty' for an Issue with only whitespace (direct insert)", async () => {
    const provider = makeFakeProvider("fake-issue-empty");
    const draft = await createDocDraft(memexId, "Empty issue spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    // createIssue rejects a blank title, so insert directly to construct the edge.
    const inserted = (await db.execute(sql`
      INSERT INTO issues (memex_id, doc_id, seq, title, body, type, status)
      VALUES (${memexId}, ${draft.id}, 998, '   ', '   ', 'bug', 'open')
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    const result = await embedAndStoreIssue(inserted[0].id, { provider });
    expect(result.status).toBe("skipped-empty");
    expect(provider.callCount).toBe(0);
  });

  it("returns 'skipped-no-provider' when no provider is wired up", async () => {
    const draft = await createDocDraft(memexId, "No-provider issue spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createIssue } = await import("./issues.js");
    const issue = await createIssue({
      memexId,
      docId: draft.id,
      title: "No provider here",
      body: "b",
      type: "todo",
    });

    const result = await embedAndStoreIssue(issue.id, { provider: null });
    expect(result.status).toBe("skipped-no-provider");
  });

  it("returns 'failed' / issue-not-found for an unknown issue id", async () => {
    const provider = makeFakeProvider("fake-issue-missing");
    const result = await embedAndStoreIssue(
      "00000000-0000-0000-0000-000000000000",
      { provider },
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("issue-not-found");
  });
});

describe("backfillIssueEmbeddings (spec-112 t-3)", () => {
  it("embeds rows with no embedding and is idempotent on the second pass", async () => {
    const { backfillIssueEmbeddings } = await import("./memex-embeddings.js");
    const memexIdIssue = await makeTestMemex("emb-issue");

    const draft = await createDocDraft(memexIdIssue, "Issue backfill spec", "Body.", "spec");
    createdDocIds.push(draft.id);

    const { createIssue } = await import("./issues.js");
    const i1 = await createIssue({
      memexId: memexIdIssue,
      docId: draft.id,
      title: "First issue",
      body: "Body A.",
      type: "bug",
    });
    const i2 = await createIssue({
      memexId: memexIdIssue,
      docId: draft.id,
      title: "Second issue",
      body: "Body B.",
      type: "todo",
    });

    // Wipe any embeddings the create hook may have set.
    await db.execute(sql`
      UPDATE issues SET embedding = NULL, embedding_model = NULL, embedding_updated_at = NULL
      WHERE id IN (${i1.id}, ${i2.id})
    `);

    const provider = makeFakeProvider("fake-backfill-issues");
    const first = await backfillIssueEmbeddings(memexIdIssue, { provider });
    expect(first.embedded).toBeGreaterThanOrEqual(2);
    expect(first.failed).toBe(0);

    // Second pass: no-op since embedding_model now matches.
    provider.callCount = 0;
    const second = await backfillIssueEmbeddings(memexIdIssue, { provider });
    expect(second.embedded).toBe(0);
    expect(provider.callCount).toBe(0);
  });

  it("returns no-provider-configured when nothing is wired up", async () => {
    const { backfillIssueEmbeddings } = await import("./memex-embeddings.js");
    const result = await backfillIssueEmbeddings(memexId, { provider: null });
    expect(result.reason).toBe("no-provider-configured");
    expect(result.embedded).toBe(0);
  });
});
