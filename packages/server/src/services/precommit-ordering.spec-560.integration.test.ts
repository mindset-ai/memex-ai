// spec-560 t-3 (dec-5) — the two shapes the guard's first real run exposed.
//
// A. VALIDATION AFTER THE COMMIT. `update_task`, `update_decision` and `edit_clause`
//    each committed their field edit and THEN validated the supplied ballot/verdict, so
//    a rejected input failed the call over an edit that had landed. `add_clause` — the
//    sibling of `edit_clause`, in the same file — already got this right and said so in
//    a comment (dec-9). Right in one branch, wrong in its twin, no rule saying which:
//    the third instance of that pattern in this Spec.
//
//    The fix is a REORDERING. Wrapping validation in `afterCommit` would let an invalid
//    ballot through, which inverts spec-499's contract — so this asserts the row is
//    UNCHANGED after a rejection, not merely that the call failed.
//
// B. DEPENDENT WRITES AFTER THE COMMIT. A clause's facets/testability rows need the
//    clause's FK, so they cannot be hoisted. They take the facet ballot's treatment
//    instead: succeed, warn, name the repair.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, documents, tasks, users } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { seedDefaultFacetsForOwner } from "./default-facets.js";
import { vocabForMemex } from "./facet-vocab.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-560";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

// ESM bindings cannot be spied after the consumer has imported them, so the failing
// dependent write is installed as a module mock, toggled per test.
const persistClauseTestability = vi.hoisted(() => vi.fn());
vi.mock("./testability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./testability.js")>()),
  persistClauseTestability,
}));

const { createMcpServer } = await import("../mcp/tools.js");

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId, undefined, undefined);
  const registry = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> }
      >;
    }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

let userId: string;
let specRef: string;
let docId: string;

beforeAll(async () => {
  const sub = `s560o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  created.users.push(u.id);
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `T ${sub}` })
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  // A vocabulary must exist or requireBallotForMemex short-circuits and there is
  // nothing to reject — the ordering defect would be invisible and this file would
  // pass while proving nothing. Seeded through the NON-best-effort path (the wrapper
  // swallows its own failure) and asserted, rather than assumed.
  await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: org.id });
  const vocab = await vocabForMemex(mx.id);
  if (vocab.length === 0) throw new Error("setup failed: no facet vocabulary to reject against");

  const doc = await createDocDraft(mx.id, "Ordering", "Purpose.", "spec");
  created.docs.push(doc.id);
  docId = doc.id;
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  specRef = `${ns.slug}/main/specs/${doc.handle}`;
});

describe("spec-560 ac-17 — update-path validation runs BEFORE the write", () => {
  it("update_task rejects an incomplete ballot and leaves the title unchanged", async () => {
    tagAc(AC(17));

    const create = await callTool(userId, "create_task", {
      ref: specRef,
      title: "ORIGINAL TITLE",
      description: "Something checkable.",
      facetBallot: { verdict: {}, none: true },
    });
    expect(create.isError).toBeFalsy();

    const row = await db.query.tasks.findFirst({ where: eq(tasks.docId, docId) });
    const taskRef = `${specRef}/tasks/t-${row!.seq}`;

    // An incomplete verdict: a vocabulary exists, so this must be rejected.
    const res = await callTool(userId, "update_task", {
      ref: taskRef,
      title: "MUTATED TITLE",
      facetBallot: { verdict: { architecture: true }, none: false },
    });

    expect(res.isError, "an incomplete ballot must still be rejected").toBeTruthy();

    // The load-bearing assertion. Before spec-560 dec-5 the title WAS committed before
    // the ballot was looked at, so this read returned "MUTATED TITLE" alongside an
    // error telling the caller nothing had happened.
    const after = await db.query.tasks.findFirst({ where: eq(tasks.id, row!.id) });
    expect(after!.title).toBe("ORIGINAL TITLE");
  });

  it("a VALID ballot still updates the row — the reorder did not break the happy path", async () => {
    tagAc(AC(17));
    const row = await db.query.tasks.findFirst({ where: eq(tasks.docId, docId) });
    const taskRef = `${specRef}/tasks/t-${row!.seq}`;

    const res = await callTool(userId, "update_task", {
      ref: taskRef,
      title: "PROPERLY UPDATED",
      facetBallot: { verdict: {}, none: true },
    });

    expect(res.isError).toBeFalsy();
    const after = await db.query.tasks.findFirst({ where: eq(tasks.id, row!.id) });
    expect(after!.title).toBe("PROPERLY UPDATED");
  });
});

describe("spec-560 ac-18 — a clause's dependent write cannot fail the clause", () => {
  it("add_clause survives a failing persistClauseTestability and names the repair", async () => {
    tagAc(AC(18));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    persistClauseTestability.mockRejectedValue(new Error("write CONNECT_TIMEOUT /cloudsql/…"));

    const std = await createDocDraft(
      (await db.query.memexes.findFirst({ where: eq(memexes.id, created.memexes[0]) }))!.id,
      "A standard",
      "Purpose.",
      "standard",
    );
    created.docs.push(std.id);
    const stdRef = specRef.replace(/\/specs\/.*$/, `/standards/${std.handle}`);

    const sec = await callTool(userId, "add_section", {
      ref: stdRef,
      sectionType: "rule",
      clauses: ["Every mutation goes through mutate()."],
      clauseFacets: [[]],
    });
    expect(sec.isError).toBeFalsy();
    const secRef = `${stdRef}/sections/s-1`;

    const res = await callTool(userId, "add_clause", {
      ref: secRef,
      body: "A second clause.",
      facets: [],
      testability: { isObligation: true, testable: true, archetype: "static-scan" },
    });

    const text = res.content.map((c) => c.text).join("\n");
    expect(res.isError, "the clause is committed — the call must not report failure").toBeFalsy();
    expect(text).toMatch(/cl-\d+/);
    expect(text).toContain("do not add it again");
    expect(text).toContain("edit_clause");
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error)).toBe(true);

    errorSpy.mockRestore();
  });
});
