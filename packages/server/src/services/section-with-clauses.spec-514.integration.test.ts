// spec-514 dec-1 — `add_section` in clauses mode was TWO mutations: the section was
// created first and the facet ballot validated second, so a rejected ballot left an
// orphaned empty section behind and the natural retry then collided on the
// (docId, sectionType) uniqueness. `addSectionWithClauses` moves the ordering into the
// service (validate → addSection → addClausesToSection), which is what makes ac-1, ac-2
// and ac-3 true by construction: no row is written, so there is nothing to collide with
// and nothing to emit.
//
// These assertions are deliberately at the SERVICE grain (ac-7): the guarantee belongs to
// the service, so proving it through the MCP handler alone would leave any future caller
// of the two primitives free to reintroduce the orphan.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
import { bus, type ChangeEvent } from "./bus.js";
import { executeServerTool } from "../agent/tools.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-514/acs/ac-${n}`;

// std-37: a per-worker-unique fixture identity, so parallel workers never share a
// namespace slug, an org, or a facet vocabulary.
const uniq = () =>
  `s514-${process.env.VITEST_POOL_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();

let userId: string;
let orgId: string;
let memexId: string;
let nsSlug: string;
const createdDocIds: string[] = [];

beforeAll(async () => {
  const slug = uniq();
  nsSlug = slug;
  const [u] = await db.insert(users).values({ email: `${slug}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${slug}` }).returning();
  orgId = org.id;
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  // A facet vocabulary is what makes a ballot REQUIRED — with none, validateClauseFacetsBatch
  // returns null-per-clause and there is no rejection to be atomic about.
  for (const key of ["s514-security", "s514-perf"]) {
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

/** Live section + clause row counts for a document — the "was anything written?" probe. */
async function rowCounts(docId: string): Promise<{ sections: number; clauses: number }> {
  const sections = await db
    .select({ id: docSections.id })
    .from(docSections)
    .where(eq(docSections.docId, docId));
  const clauses = await db
    .select({ id: standardClauses.id })
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")));
  return { sections: sections.length, clauses: clauses.length };
}

describe("spec-514 dec-1: a rejected ballot writes nothing (ac-7, ac-1)", () => {
  it("leaves ZERO doc_sections and ZERO standard_clauses rows when a verdict is missing", async () => {
    tagAc(AC(7));
    tagAc(AC(1));
    const docId = await newStandard("Atomic Rejection Standard");

    // Five clauses, four verdicts — the exact miscount that surfaced this bug on a
    // cold-start standards bootstrap.
    await expect(
      addSectionWithClauses(
        memexId,
        docId,
        "scope",
        [
          { body: "One.", facets: ["s514-security"] },
          { body: "Two.", facets: [] },
          { body: "Three.", facets: [] },
          { body: "Four.", facets: [] },
          { body: "Five.", facets: undefined }, // the under-counted ballot
        ],
        "Scope",
      ),
    ).rejects.toThrow();

    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });

  it("leaves nothing behind when the verdict names an unknown facet key", async () => {
    tagAc(AC(7));
    tagAc(AC(1));
    const docId = await newStandard("Unknown Key Standard");

    await expect(
      addSectionWithClauses(
        memexId,
        docId,
        "rule",
        [{ body: "A rule.", facets: ["not-a-real-facet"] }],
        "Rule",
      ),
    ).rejects.toThrow(/Clause 1 names unknown facet key/);

    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });
});

describe("spec-514: the natural retry is the retry that works (ac-2)", () => {
  it("re-running the IDENTICAL call with the ballot fixed succeeds — same sectionType", async () => {
    tagAc(AC(2));
    const docId = await newStandard("Retry Standard");
    const bodies = ["Rule one.", "Rule two."];

    // First attempt: one verdict short.
    await expect(
      addSectionWithClauses(
        memexId,
        docId,
        "scope",
        [
          { body: bodies[0], facets: ["s514-security"] },
          { body: bodies[1], facets: undefined },
        ],
        "Scope",
      ),
    ).rejects.toThrow();

    // The retry an agent with no memory of the previous attempt would naturally make:
    // SAME sectionType, SAME clauses, one verdict added. Before dec-1 this threw
    // "Section type 'scope' already exists on this document."
    const result = await addSectionWithClauses(
      memexId,
      docId,
      "scope",
      [
        { body: bodies[0], facets: ["s514-security"] },
        { body: bodies[1], facets: [] },
      ],
      "Scope",
    );

    expect(result.clauses).toHaveLength(2);
    expect(await rowCounts(docId)).toEqual({ sections: 1, clauses: 2 });
    const section = await db.query.docSections.findFirst({
      where: and(eq(docSections.docId, docId), eq(docSections.sectionType, "scope")),
    });
    expect(section!.content).toBe(bodies.join("\n\n"));
  });
});

describe("spec-514: a failed call is invisible to real-time subscribers (ac-3)", () => {
  it("emits no section-created event on the bus for a call that ultimately failed", async () => {
    tagAc(AC(3));
    const docId = await newStandard("No Phantom Event Standard");

    const events: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe({ memexId, docId }, (e) => events.push(e));
    try {
      await expect(
        addSectionWithClauses(
          memexId,
          docId,
          "rule",
          [
            { body: "First.", facets: [] },
            { body: "Second.", facets: undefined },
          ],
          "Rule",
        ),
      ).rejects.toThrow();
    } finally {
      unsubscribe();
    }

    // Nothing at all should reach a subscriber watching this document: no section
    // created, no clause created, no section updated.
    expect(events.filter((e) => e.entity === "section" && e.action === "created")).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

// The bug as REPORTED: authoring a standard over MCP with a miscounted ballot. This is the
// behavioural reproduction — it fails against the two-primitive handler (an orphaned
// `scope` section persists and the retry collides) and passes once the handler delegates
// to addSectionWithClauses. The service-grain tests above prove the guarantee lives in the
// right layer; this one proves the surface the user actually hit is fixed.
describe("spec-514: the reported bug, through the add_section tool (ac-1, ac-2, ac-4)", () => {
  it("a miscounted ballot over MCP leaves no orphan, and the identical retry then succeeds", async () => {
    tagAc(AC(1));
    tagAc(AC(2));
    tagAc(AC(4));
    const docId = await newStandard("MCP Bootstrap Standard");
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    const docRef = `${nsSlug}/main/standards/${doc!.handle}`;

    // 5 clauses, 4 verdicts — over the tool boundary, exactly as observed.
    let message = "";
    try {
      await executeServerTool(
        memexId,
        "add_section",
        {
          ref: docRef,
          sectionType: "scope",
          clauses: ["One.", "Two.", "Three.", "Four.", "Five."],
          clauseFacets: [["s514-security"], [], [], []],
        },
        userId,
      );
      throw new Error("expected the miscounted ballot to be rejected");
    } catch (err) {
      message = (err as Error).message;
    }

    // ac-4: the failure names the real problem and never steers the agent toward
    // inventing a section type (which on a standard produces a mis-keyed section).
    expect(message).not.toMatch(/already exists on this document/);
    expect(message).not.toMatch(/scope-2/);

    // ac-1: the document is exactly as it was — no orphaned empty `scope` section.
    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });

    // ac-2: the identical call, ballot corrected, now succeeds.
    await executeServerTool(
      memexId,
      "add_section",
      {
        ref: docRef,
        sectionType: "scope",
        clauses: ["One.", "Two.", "Three.", "Four.", "Five."],
        clauseFacets: [["s514-security"], [], [], [], []],
      },
      userId,
    );
    expect(await rowCounts(docId)).toEqual({ sections: 1, clauses: 5 });
  });
});

describe("spec-514 dec-1: the handler no longer sequences the two primitives (ac-6)", () => {
  it("the add_section handler calls addSectionWithClauses and never addClausesToSection", () => {
    tagAc(AC(6));
    const handlerPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../agent/handlers/sections.ts",
    );
    const src = readFileSync(handlerPath, "utf8");

    // The ordering guarantee lives in the service now; a handler that still reaches for
    // the bulk clause primitive is sequencing it itself and can reintroduce the orphan.
    expect(src).toContain("addSectionWithClauses");
    expect(src).not.toContain("addClausesToSection");
  });
});

// ac-8 is a claim about the SOURCE — that the seeder adopted the service function and that
// its content-seeding workaround is gone — so it is verified against the source. The
// seeder's BEHAVIOUR (a seeded Standard renders, with content = its clauses joined) is
// covered by default-standards.integration.test.ts and
// standards-bootstrap-facet-verdict.spec-438.integration.test.ts, which both run green
// against this change; duplicating their fixture here would add no signal.
describe("spec-514 dec-1: the seeder adopted the service and dropped its workaround (ac-8)", () => {
  const seederSrc = () =>
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "./default-standards.ts"),
      "utf8",
    );

  it("seedDefaultStandards calls addSectionWithClauses and neither primitive directly", () => {
    tagAc(AC(8));
    const src = seederSrc();
    expect(src).toContain("addSectionWithClauses");
    expect(src).not.toContain("addClausesToSection");
    // `addSection(` with an open paren — the bare word survives inside
    // "addSectionWithClauses", which is the point.
    expect(src).not.toMatch(/\baddSection\(/);
  });

  it("no longer pre-seeds a section's content to the clause join, and the comment is gone", () => {
    tagAc(AC(8));
    const src = seederSrc();
    // The workaround was `section.clauses.join("\n\n")` passed as addSection's content arg.
    expect(src).not.toMatch(/clauses\.join\(/);
    expect(src).not.toContain(
      "so a crash between addSection and addClausesToSection still leaves a rendered section",
    );
  });

  it("keeps the pool-posture comment that grounds dec-1's rejection of one transaction", () => {
    tagAc(AC(8));
    // Deleting this alongside the workaround would erase the recorded REASON each
    // primitive opens its own short transaction — the constraint that ruled out merging
    // them, and a failure mode that was actually hit.
    expect(seederSrc()).toMatch(/accumulate HELD connections/);
  });
});

// ── ac-5: the Spec's actual promise ──────────────────────────────────────────────────
// dec-3 deliberately NARROWED ac-5 from "every failure mode" to the modes this Spec
// delivers, because an AC that promises more than the code keeps cannot be honestly
// verified. All four are asserted here, at the service, by the same "did anything get
// written?" probe — one table so a fifth mode has an obvious home.
//
// Worth recording which guard fires, because the narrative implies one and there are
// three: the two ballot modes throw in collectClauseFacetProblems; a whitespace body
// throws in validateClauseBatch; and an EMPTY ARRAY throws on validateClauseBatch's
// length check. A fourth guard sits further out on the tool path — the handler computes
// `hasClauses` from the raw strings, so an all-whitespace array never reaches the service
// at all: resolveSectionWriteMode rejects it with "A standard section needs `clauses`".
// (dec-2/dec-3 attribute the all-empty rejection to resolveSectionWriteMode alone, which
// is true only of the handler path — see c-1.)
describe("spec-514: EVERY rejection mode leaves the document untouched (ac-5)", () => {
  const modes: { label: string; clauses: { body: string; facets: string[] | undefined }[]; guard: RegExp }[] = [
    {
      label: "a verdict missing for one clause of several",
      clauses: [
        { body: "One.", facets: [] },
        { body: "Two.", facets: undefined },
      ],
      guard: /Clause 2 has no facet verdict/,
    },
    {
      label: "a verdict naming an unknown facet key",
      clauses: [{ body: "One.", facets: ["no-such-facet"] }],
      guard: /Clause 1 names unknown facet key/,
    },
    {
      label: "a whitespace-only clause body",
      clauses: [
        { body: "One.", facets: [] },
        { body: "  \n ", facets: [] },
      ],
      guard: /Clause 2 has an empty body/,
    },
    {
      label: "an all-empty clause list",
      clauses: [],
      guard: /At least one non-empty clause is required/,
    },
  ];

  it.each(modes)("$label — no section row, no clause row", async ({ clauses, guard }) => {
    tagAc(AC(5));
    tagAc(AC(1));
    const docId = await newStandard(`Mode Standard ${Math.random().toString(36).slice(2, 8)}`);

    await expect(
      addSectionWithClauses(memexId, docId, "rule", clauses, "Rule"),
    ).rejects.toThrow(guard);

    expect(await rowCounts(docId)).toEqual({ sections: 0, clauses: 0 });
  });
});
