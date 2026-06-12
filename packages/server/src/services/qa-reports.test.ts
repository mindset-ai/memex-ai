// spec-260 t-2: the append-versioned QA report write path (dec-1, dec-2).
//
// ac-14: a Spec taken through more than one build session retains each session's
// report as a distinct, dated version — an earlier session's report remains
// retrievable after a later one is written (APPEND, not overwrite).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docSections, documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { actorCtx } from "./actor.js";
import {
  appendQaReport,
  nextQaReportSectionType,
  qaReportVersion,
} from "./qa-reports.js";

const AC_14 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-14";

describe("spec-260: append-versioned QA report write path", () => {
  let memexId: string;
  let docId: string;
  let ctx: ReturnType<typeof actorCtx>;

  beforeAll(async () => {
    memexId = await makeTestMemex("qa");
    const user = await upsertUserByEmail(`qa-report-${Date.now()}@memex.ai`);
    ctx = actorCtx(user, "mcp");
    const [doc] = await db
      .insert(documents)
      .values({
        memexId,
        handle: `spec-${Date.now().toString(36)}`,
        title: "QA report append spec",
        docType: "spec",
      })
      .returning();
    docId = doc!.id;
  });

  afterAll(async () => {
    await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
  });

  it("computes qa_report for the first session, then qa_report-2, qa_report-3 …", async () => {
    expect(qaReportVersion("qa_report")).toBe(1);
    expect(qaReportVersion("qa_report-2")).toBe(2);
    expect(qaReportVersion("overview")).toBeNull();
    // Fresh doc → first key is the bare prefix.
    expect(await nextQaReportSectionType(docId)).toBe("qa_report");
  });

  it("ac-14: a second build session appends a new version; the first stays retrievable", async () => {
    tagAc(AC_14);

    const first = await appendQaReport(
      memexId,
      docId,
      "## Front-end\nSession 1 FE changes.\n## Back-end\nSession 1 BE changes.",
      undefined,
      ctx,
    );
    expect(first.sectionType).toBe("qa_report");

    // A later build session writes again — must NOT overwrite the first.
    const second = await appendQaReport(
      memexId,
      docId,
      "## Front-end\nSession 2 FE changes.",
      undefined,
      ctx,
    );
    expect(second.sectionType).toBe("qa_report-2");
    expect(second.id).not.toBe(first.id);

    // Both rows exist and are independently retrievable; the first session's
    // content is untouched (append, not overwrite).
    const rows = await db
      .select()
      .from(docSections)
      .where(and(eq(docSections.docId, docId), eq(docSections.status, "active")))
      .orderBy(asc(docSections.createdAt), asc(docSections.seq));

    const reports = rows.filter((r) => qaReportVersion(r.sectionType) !== null);
    expect(reports.map((r) => r.sectionType)).toEqual(["qa_report", "qa_report-2"]);

    const firstRow = reports.find((r) => r.sectionType === "qa_report")!;
    expect(firstRow.content).toContain("Session 1 FE changes.");
    expect(firstRow.content).toContain("Session 1 BE changes.");

    // The actor contract (std-32) is stamped — this is the "who executed it" the feed shows.
    expect(firstRow.actorUserId).toBe(ctx.actorUserId);
    expect(firstRow.channel).toBe("mcp");

    // A third session continues the sequence.
    expect(await nextQaReportSectionType(docId)).toBe("qa_report-3");
  });
});
