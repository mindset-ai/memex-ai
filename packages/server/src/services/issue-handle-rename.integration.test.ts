// spec-158 t-1 — Hard cutover of the issue child handle `i-N` → `issue-N`.
//
// Per dec-3 there is NO backwards-compat alias (product unreleased): the bare
// `i-N` form must no longer parse, render, or be emitted, and the canonical child
// ref shape is now `.../specs/spec-N/issues/issue-N`. This file proves the rename
// across the three server-side parse/emit surfaces (ac-14) and the one-time stored-
// body migration transform (ac-15).
//
// The conversion-string assertions are DB-backed because the only place the server
// emits `Issue <handle>` prose into a stored body is convertIssueToTask, which is a
// multi-table atomic write — a mock would pass while the real join drifted.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, issues, tasks, acs } from "../db/schema.js";
import { parseRef, formatRef } from "./refs.js";
import { mutate } from "./mutate.js";
import { bus, type ChangeEvent } from "./bus.js";
import { rewriteIssueHandlesInBody } from "./shared/issue-handle-rewrite.js";
import { createDocDraft } from "./documents.js";
import { createIssue, convertIssueToTask } from "./issues.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC5 = "mindset-prod/memex-building-itself/specs/spec-158/acs/ac-5";
const AC14 = "mindset-prod/memex-building-itself/specs/spec-158/acs/ac-14";
const AC15 = "mindset-prod/memex-building-itself/specs/spec-158/acs/ac-15";

const NS = "mindset-prod";
const MX = "memex-building-itself";

// ── ac-14: parse / render / emit the new `issue-N` form; reject the bare `i-N` ──

describe("issue handle rename — refs.ts parse + render (ac-14)", () => {
  it("parses the canonical issue child ref as issues/issue-N", () => {
    tagAc(AC14);
    const ref = `${NS}/${MX}/specs/spec-3/issues/issue-2`;
    const result = parseRef(ref);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref.child).toEqual({ type: "issues", handle: "issue-2" });
    }
  });

  it("renders an issue child ref with the issue-N handle", () => {
    tagAc(AC14);
    const rendered = formatRef({
      namespace: NS,
      memex: MX,
      docType: "specs",
      docHandle: "spec-3",
      child: { type: "issues", handle: "issue-7" },
    });
    expect(rendered).toBe(`${NS}/${MX}/specs/spec-3/issues/issue-7`);
  });

  it("rejects the legacy bare i-N issue handle (no backwards-compat alias, dec-3)", () => {
    tagAc(AC14);
    tagAc(AC5);
    const result = parseRef(`${NS}/${MX}/specs/spec-3/issues/i-2`);
    expect(result.ok).toBe(false);
  });

  it("still rejects a non-issue handle under /issues (e.g. dec-2)", () => {
    tagAc(AC14);
    expect(parseRef(`${NS}/${MX}/specs/spec-3/issues/dec-2`).ok).toBe(false);
  });
});

describe("issue handle rename — mutate() handle mint (ac-14)", () => {
  it("renders the issue-N handle in the Pulse narrative, never the bare i-N", async () => {
    tagAc(AC14);
    bus._reset();
    const events: ChangeEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    await mutate(
      {},
      { memexId: "m1", docId: "uuid-doc", entity: "issue", action: "created" },
      async () => ({ id: "uuid-issue", seq: 5, docHandle: "spec-3" }),
    );
    bus._reset();
    expect(events).toHaveLength(1);
    expect(events[0].narrative).toBe("created issue issue-5 on spec-3");
    expect(events[0].narrative).not.toMatch(/\bi-5\b/);
  });
});

describe("issue handle rename — issues.ts conversion strings (ac-14)", () => {
  let memexId: string;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("rename");
  });

  afterAll(async () => {
    for (const id of createdDocIds) {
      await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
      await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
      await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
      await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
    }
  });

  it("emits 'Issue issue-N' (not 'Issue i-N') into the Task description + AC statement", async () => {
    tagAc(AC14);
    const doc = await createDocDraft(memexId, "Rename conversion Spec", "Purpose", "spec");
    createdDocIds.push(doc.id);

    const issue = await createIssue({
      memexId,
      docId: doc.id,
      title: "Cache misses",
      body: "Symptom body.",
      type: "bug",
    });

    const { task, acId } = await convertIssueToTask(memexId, issue.id);

    expect(task.description).toContain(`Converted from Issue issue-${issue.seq}`);
    expect(task.description).not.toMatch(/Issue i-\d+/);

    const [ac] = await db.select().from(acs).where(eq(acs.id, acId)).limit(1);
    expect(ac.statement).toContain(`Issue issue-${issue.seq}`);
    expect(ac.statement).not.toMatch(/Issue i-\d+/);
  });
});

// ── ac-15: the one-time body-rewrite transform (helper + migration mirror) ──

describe("issue handle rename — stored-body rewrite (ac-15)", () => {
  it("rewrites the canonical /issues/i-N path form to /issues/issue-N", () => {
    tagAc(AC15);
    const before = `See ${NS}/${MX}/specs/spec-3/issues/i-9 for the bug.`;
    expect(rewriteIssueHandlesInBody(before)).toBe(
      `See ${NS}/${MX}/specs/spec-3/issues/issue-9 for the bug.`,
    );
  });

  it("rewrites the prose 'Issue i-N' / 'issue i-N' form", () => {
    tagAc(AC15);
    expect(rewriteIssueHandlesInBody("Converted from Issue i-3 [bug].")).toBe(
      "Converted from Issue issue-3 [bug].",
    );
    expect(rewriteIssueHandlesInBody("Promoted issue i-12 to Spec.")).toBe(
      "Promoted issue issue-12 to Spec.",
    );
  });

  it("rewrites multiple occurrences and both shapes in one body", () => {
    tagAc(AC15);
    const before =
      `Issue i-1 and ${NS}/${MX}/specs/spec-3/issues/i-2 both block this.`;
    expect(rewriteIssueHandlesInBody(before)).toBe(
      `Issue issue-1 and ${NS}/${MX}/specs/spec-3/issues/issue-2 both block this.`,
    );
  });

  it("leaves OTHER handles untouched (dec-3, t-1, s-2, c-4, ac-7)", () => {
    tagAc(AC15);
    const body = "Resolves dec-3 via t-1, see s-2 / c-4, verified by ac-7.";
    expect(rewriteIssueHandlesInBody(body)).toBe(body);
  });

  it("leaves prose collisions untouched (i-beam, wi-fi, bare i-5)", () => {
    tagAc(AC15);
    const body = "An i-beam over wi-fi; the i-5 lane has nothing to do with issues.";
    expect(rewriteIssueHandlesInBody(body)).toBe(body);
  });

  it("is idempotent — re-running over an already-rewritten body is a no-op", () => {
    tagAc(AC15);
    const once = rewriteIssueHandlesInBody(
      `Issue i-1 at ${NS}/${MX}/specs/spec-3/issues/i-2.`,
    );
    expect(rewriteIssueHandlesInBody(once)).toBe(once);
  });

  it("returns short non-matching bodies unchanged", () => {
    tagAc(AC15);
    expect(rewriteIssueHandlesInBody("nothing here")).toBe("nothing here");
  });
});
