// spec-514 dec-2 — atomicity alone still leaves the agent guessing. "A facet verdict is
// required for each clause." is true and unactionable: it restates a rule the agent already
// knows and withholds the one fact it needs — WHICH clause it under-counted. Every
// clause-level rejection must name the offending clause by its 1-based position, report
// every offender in one round trip, and count positions in the CALLER's array.
//
// The off-by-one (ac-12) is the point, not a detail: a whitespace clause at position 2
// shifts every later clause by one, so a message built after filtering would name "clause
// 4" while pointing at the caller's clause 5 — satisfying the letter of "name the clause"
// while sending the agent to the wrong line.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  docSections,
  standardClauses,
  facets,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSectionWithClauses } from "./clauses.js";
import { validateClauseFacetsBatch } from "./facet-vocab.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-514/acs/ac-${n}`;

// std-37: per-worker-unique fixture identity.
const uniq = () =>
  `s514p-${process.env.VITEST_POOL_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();

let userId: string;
let orgId: string;
let memexId: string;
const createdDocIds: string[] = [];

beforeAll(async () => {
  const slug = uniq();
  const [u] = await db.insert(users).values({ email: `${slug}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${slug}` }).returning();
  orgId = org.id;
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });
  // No digit "4" anywhere in these keys — ac-12 asserts the absence of a mis-pointed
  // position and must not trip over the re-handed vocabulary.
  for (const key of ["pos-security", "pos-perf"]) {
    await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key });
  }
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

async function newStandard(title: string): Promise<string> {
  const doc = await createDocDraft(memexId, title, "", "standard");
  createdDocIds.push(doc.id);
  return doc.id;
}

async function rowCounts(docId: string): Promise<{ sections: number; clauses: number }> {
  const sections = await db.select({ id: docSections.id }).from(docSections).where(eq(docSections.docId, docId));
  const clauses = await db
    .select({ id: standardClauses.id })
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")));
  return { sections: sections.length, clauses: clauses.length };
}

/** Run a batch through the service and return the rejection message. */
async function rejectionMessage(docId: string, sectionType: string, clauses: { body: string; facets: string[] | undefined }[]): Promise<string> {
  try {
    await addSectionWithClauses(memexId, docId, sectionType, clauses, "Section");
    throw new Error("expected the batch to be rejected");
  } catch (err) {
    return (err as Error).message;
  }
}

describe("spec-514 dec-2: the missing-verdict error names every offender (ac-9)", () => {
  it("validateClauseFacetsBatch names ALL clauses lacking a verdict, by 1-based position", async () => {
    tagAc(AC(9));
    // Verdicts for clauses 1 and 4; clauses 2 and 3 have none.
    const message = await validateClauseFacetsBatch(memexId, [
      ["pos-security"],
      undefined,
      undefined,
      [],
    ]).then(
      () => "",
      (err: Error) => err.message,
    );

    expect(message).not.toBe("");
    // Both offenders in one round trip — not just the first.
    expect(message).toMatch(/Clauses 2, 3 have no facet verdict/);
    // The generic, unactionable message is gone.
    expect(message).not.toMatch(/A facet verdict is required for each clause\./);
    // The vocabulary is still re-handed so the agent can fix it without another call.
    expect(message).toContain("pos-security");
  });

  it("names a single offender in the singular", async () => {
    tagAc(AC(9));
    const message = await validateClauseFacetsBatch(memexId, [[], undefined]).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).toMatch(/Clause 2 has no facet verdict/);
  });
});

describe("spec-514 dec-2: the unknown-key error names which clause carried it (ac-10)", () => {
  it("names the position alongside the bad keys and the re-handed vocabulary", async () => {
    tagAc(AC(10));
    const message = await validateClauseFacetsBatch(memexId, [
      ["pos-security"],
      ["not-a-facet", "also-not"],
    ]).then(
      () => "",
      (err: Error) => err.message,
    );

    expect(message).toMatch(/Clause 2 names unknown facet key/);
    expect(message).toContain("not-a-facet");
    expect(message).toContain("also-not");
    expect(message).toContain("pos-perf"); // vocabulary re-handed
  });
});

describe("spec-514 dec-2: a whitespace-only body fails the call (ac-11)", () => {
  it("rejects the whole batch, names the clause by position, and writes nothing", async () => {
    tagAc(AC(11));
    const docId = await newStandard("Whitespace Clause Standard");

    const message = await rejectionMessage(docId, "rule", [
      { body: "A real rule.", facets: ["pos-security"] },
      { body: "   \n  ", facets: [] }, // whitespace only — used to be dropped silently
      { body: "Another real rule.", facets: [] },
    ]);

    expect(message).toMatch(/Clause 2 has an empty body/);
    // The silent drop is gone: the caller asked for 3 clauses, so it does not get 2.
    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });

  it("an all-empty clause list is still rejected before any write", async () => {
    tagAc(AC(11));
    const docId = await newStandard("All Empty Standard");
    const message = await rejectionMessage(docId, "rule", [
      { body: "  ", facets: [] },
      { body: "", facets: [] },
    ]);
    expect(message).toMatch(/Clauses 1, 2 have an empty body/);
    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });
});

describe("spec-514 dec-2: positions are the caller's ORIGINAL indices (ac-12)", () => {
  it("clause 2 whitespace + clause 5 missing a verdict reports 2 and 5 — never 4", async () => {
    tagAc(AC(12));
    const docId = await newStandard("Off By One Guard Standard");

    const message = await rejectionMessage(docId, "scope", [
      { body: "One.", facets: ["pos-security"] },
      { body: "  \t ", facets: [] }, // empty body at position 2
      { body: "Three.", facets: [] },
      { body: "Four.", facets: [] },
      { body: "Five.", facets: undefined }, // missing verdict at position 5
    ]);

    // BOTH problem classes surface in one message — otherwise the empty-body throw
    // preempts the verdict check and this guard can never observe the position at all.
    expect(message).toMatch(/Clause 2 has an empty body/);
    expect(message).toMatch(/Clause 5 has no facet verdict/);

    // THE GUARD: had the empty clause been filtered out first, the fifth clause would
    // have become index 4 and the message would point at the caller's clause 4.
    expect(message).not.toMatch(/Clause 4 has no facet verdict/);

    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });
});
