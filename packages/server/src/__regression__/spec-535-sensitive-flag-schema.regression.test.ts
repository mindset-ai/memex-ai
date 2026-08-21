// spec-535 t-1 — the sensitivity flag's storage shape, introduced by migration
// 0132_spec535_sensitive_flag.
//
// Proves ac-6: sensitivity is stored on `documents` as
//   sensitive boolean NOT NULL DEFAULT false
//   + sensitive_by_user_id + sensitive_by_name
// and that NO document_tags row and NO enum participates in deciding whether a
// Spec is flagged.
//
// That last clause is the point of the AC, not decoration. dec-1 weighed a
// `sensitivity::high` TAG (free — the machinery, the picker and the MCP header
// rendering all already exist) and rejected it because tags are a
// user-extensible {scope,value} vocabulary the server cannot trust, and an
// untrustworthy value cannot back a guaranteed warning (ac-2). A future edit
// that "simplifies" this into a tag would quietly undo that reasoning, so the
// absence is asserted rather than assumed.
//
// Runs against the local dev DB, like the other __regression__ specs.
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → reports pass/fail to the PROD memex
// (the Spec lives at mindset-prod/…).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, documentTags } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-535/acs";

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function columnsOnDocuments(): Promise<Map<string, ColumnRow>> {
  // drizzle's `execute` returns the postgres-js RowList shape directly on this
  // driver (same note as schema-state.regression.test.ts).
  const rows = (await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents'
  `)) as unknown as ColumnRow[];
  return new Map(rows.map((r) => [r.column_name, r]));
}

describe("regression: sensitivity flag schema [spec-535 t-1]", () => {
  let memexId: string;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("sensitive");
  });

  afterAll(async () => {
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
  });

  async function makeDoc(handle: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle, title: handle, docType: "spec" })
      .returning();
    createdDocIds.push(doc.id);
    return doc.id;
  }

  it("ac-6: `sensitive` is a boolean NOT NULL defaulting to false — not an enum", async () => {
    tagAc(`${AC}/ac-6`);
    const cols = await columnsOnDocuments();
    const sensitive = cols.get("sensitive");

    expect(sensitive, "documents.sensitive is missing — did 0132 apply?").toBeDefined();
    // `boolean`, never `USER-DEFINED`: a USER-DEFINED type here would mean someone
    // reintroduced the graded enum dec-1 rejected.
    expect(sensitive!.data_type).toBe("boolean");
    expect(sensitive!.is_nullable).toBe("NO");
    expect(sensitive!.column_default).toMatch(/false/);
  });

  it("ac-6: provenance is a uuid id + a denormalised name, both nullable", async () => {
    tagAc(`${AC}/ac-6`);
    const cols = await columnsOnDocuments();

    const byUserId = cols.get("sensitive_by_user_id");
    expect(byUserId, "documents.sensitive_by_user_id is missing").toBeDefined();
    expect(byUserId!.data_type).toBe("uuid");
    expect(byUserId!.is_nullable).toBe("YES");

    const byName = cols.get("sensitive_by_name");
    expect(byName, "documents.sensitive_by_name is missing").toBeDefined();
    expect(byName!.data_type).toBe("text");
    expect(byName!.is_nullable).toBe("YES");
  });

  it("ac-6: the provenance id carries no FK, matching grounded_by_user_id / archived_by_user_id", async () => {
    tagAc(`${AC}/ac-6`);
    // std-32's denormalised-snapshot pattern deliberately omits the FK on the
    // provenance id so a hard-deleted user cannot cascade away history. 0112 and
    // 0131 both did this; 0132 follows. An FK appearing here means the pattern
    // was broken.
    const rows = (await db.execute(sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'documents'
        AND tc.constraint_type = 'FOREIGN KEY'
    `)) as unknown as Array<{ column_name: string }>;

    expect(rows.map((r) => r.column_name)).not.toContain("sensitive_by_user_id");
  });

  it("ac-6: a new document defaults to not-sensitive with empty provenance", async () => {
    tagAc(`${AC}/ac-6`);
    const docId = await makeDoc("spec-sensitive-default");

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(false);
    expect(row.sensitiveByUserId).toBeNull();
    expect(row.sensitiveByName).toBeNull();
  });

  it("ac-6: flagging a Spec writes only the document row — no document_tags row participates", async () => {
    tagAc(`${AC}/ac-6`);
    const docId = await makeDoc("spec-sensitive-flagged");

    await db
      .update(documents)
      .set({ sensitive: true, sensitiveByName: "someone" })
      .where(eq(documents.id, docId));

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(true);

    // The behavioural half of "not a tag": a flagged Spec carries no tag rows.
    // If a future change routes sensitivity through document_tags, this fails.
    const tagRows = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.docId, docId));
    expect(tagRows).toHaveLength(0);
  });
});
