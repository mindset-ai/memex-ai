// spec-161 — the standard read path surfaces clauses with their short cl-N handles for
// the agent (citation + edit targets), while the lossless export stays clean (ac-14).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createClause } from "./clauses.js";
import { getStandard } from "./standards.js";
import { formatStandard } from "../mcp/formatters.js";
import { buildDocExportForm } from "./doc-export.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-161/acs/ac-${n}`;

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

async function standardWithClauses(): Promise<{ docId: string }> {
  const doc = await createDocDraft(memexId, "Read-path Standard", "purpose", "standard");
  createdDocIds.push(doc.id);
  const section = await addSection(memexId, doc.id, "rule", "seed");
  await createClause(memexId, section.id, "Every change ships with smoke tests.");
  await createClause(memexId, section.id, "Smoke is green before prod.");
  return { docId: doc.id };
}

describe("spec-161: clause handles in the read path, clean export (ac-14)", () => {
  it("formatStandard renders inline cl-N handles and never a canonical clause ref", async () => {
    tagAc(AC(14));
    const { docId } = await standardWithClauses();

    const rendered = formatStandard(await getStandard(memexId, docId));

    expect(rendered).toContain("[cl-1] Every change ships with smoke tests.");
    expect(rendered).toContain("[cl-2] Smoke is green before prod.");
    // Short handles only — the canonical clause-ref form must never appear here.
    expect(rendered).not.toContain("/clauses/cl-");
  });

  it("the lossless export renders the standard clean — no cl-N handles", async () => {
    tagAc(AC(14));
    const { docId } = await standardWithClauses();

    const exported = await buildDocExportForm(memexId, docId);

    // Content is preserved verbatim...
    expect(exported).toContain("Every change ships with smoke tests.");
    expect(exported).toContain("Smoke is green before prod.");
    // ...but the agent-facing clause handles are absent from the human export.
    expect(exported).not.toContain("[cl-1]");
    expect(exported).not.toContain("[cl-2]");
  });
});
