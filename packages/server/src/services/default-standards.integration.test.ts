// Integration tests for the default-Standards seed + backfill (spec-184 t-2 / t-4).
// DB-backed by design: seedDefaultStandards composes the real clause-first standard
// primitives (createDocDraft → addSection → addClausesToSection), so a pure unit test
// would pass while the clause composition / content-join silently broke. These assert
// against the same rows the Standards list + standard read paths consume.
//
// Emission no-ops locally without MEMEX_EMIT_KEY — irrelevant here: the ac-11 test
// observes the in-process bus directly (bus.subscribe), not the /api/test-events POST.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, asc, eq, ne, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  standardClauses,
  namespaces,
  memexes,
  users,
} from "../db/schema.js";
import { seedDefaultStandards, backfillDefaultStandards } from "./default-standards.js";
import * as defaultStandardsModule from "./default-standards.js";
import { createDocDraft } from "./documents.js";
import { updateClause } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import { DEFAULT_STANDARDS, DEFAULT_STANDARDS_COUNT } from "../db/default-standards.fixture.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-184";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const memexIds: string[] = [];
const userNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueSlug(prefix: string): string {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

// A personal (kind='user') namespace + memex — makeTestMemex makes an org-kind one,
// which the backfill (namespaces.kind='user') must NOT pick up. Mirrors the handhold
// integration test's helper.
async function makePersonalMemex(): Promise<{ memexId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniqueSlug("ds-user")}@example.com`, name: "DS User" })
    .returning();
  createdUserIds.push(user.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: uniqueSlug("ds-ns"), kind: "user", ownerUserId: user.id })
    .returning();
  userNamespaceIds.push(ns.id);
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "personal", name: "Personal" })
    .returning();
  memexIds.push(memex.id);
  return { memexId: memex.id };
}

async function standardDocs(memexId: string) {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, "standard")));
}

afterAll(async () => {
  for (const memexId of memexIds) {
    await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  }
  for (const nsId of userNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nsId)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("seedDefaultStandards — the six default Standards", () => {
  let memexId: string;

  beforeAll(async () => {
    ({ memexId } = await makePersonalMemex());
    await seedDefaultStandards(memexId);
  });

  it("seeds exactly the six default Standards into a fresh personal Memex (ac-7)", async () => {
    tagAc(AC(7));
    tagAc(AC(1)); // scope ac-1: a new user's Standards list is never empty
    const docs = await standardDocs(memexId);
    expect(docs).toHaveLength(DEFAULT_STANDARDS_COUNT);
    expect(docs.length).toBe(6);
    expect(new Set(docs.map((d) => d.title))).toEqual(
      new Set(DEFAULT_STANDARDS.map((s) => s.title)),
    );
    // Ordinary standard rows: docType='standard', not demo-flagged.
    expect(docs.every((d) => d.docType === "standard")).toBe(true);
    expect(docs.every((d) => d.isDemo === false)).toBe(true);
  });

  it("builds each Standard clause-first: sections match the fixture and content is the clause join (ac-8)", async () => {
    tagAc(AC(8));
    tagAc(AC(2)); // scope ac-2: each default is a well-formed Rule+Rationale+Scope example
    tagAc(AC(16)); // the seeded rows match the committed fixture verbatim — it is the single source
    const docs = await standardDocs(memexId);
    const byTitle = new Map(docs.map((d) => [d.title, d]));

    for (const std of DEFAULT_STANDARDS) {
      const doc = byTitle.get(std.title);
      expect(doc, `expected a seeded standard titled "${std.title}"`).toBeDefined();

      const sections = await db
        .select()
        .from(docSections)
        .where(eq(docSections.docId, doc!.id))
        .orderBy(asc(docSections.seq));
      // Section types appear in fixture order (Description + Rule + Rationale + Scope).
      expect(sections.map((s) => s.sectionType)).toEqual(
        std.sections.map((s) => s.sectionType),
      );

      for (const fixtureSection of std.sections) {
        const section = sections.find((s) => s.sectionType === fixtureSection.sectionType)!;
        const clauses = await db
          .select()
          .from(standardClauses)
          .where(
            and(eq(standardClauses.sectionId, section.id), ne(standardClauses.status, "deleted")),
          )
          .orderBy(asc(standardClauses.position));
        // One clause row per fixture clause, bodies verbatim.
        expect(clauses.map((c) => c.body)).toEqual(fixtureSection.clauses);
        // Clause-first invariant: section content === ordered join of its clauses.
        expect(section.content).toBe(fixtureSection.clauses.join("\n\n"));
      }
    }
  });

  it("is idempotent — re-seeding an already-seeded Memex adds nothing and keeps the same rows (ac-10)", async () => {
    tagAc(AC(10));
    const before = await standardDocs(memexId);
    expect(before).toHaveLength(6);
    await seedDefaultStandards(memexId);
    await seedDefaultStandards(memexId);
    const after = await standardDocs(memexId);
    expect(after).toHaveLength(6);
    // The very same rows — no churn (ids stable), so no duplicate Standards.
    expect(new Set(after.map((d) => d.id))).toEqual(new Set(before.map((d) => d.id)));
  });
});

describe("seedDefaultStandards — the zero-Standards guard (dec-3 / dec-4)", () => {
  it("NO-OPs on a Memex that already has a user-authored Standard (never intrudes on a non-empty list)", async () => {
    tagAc(AC(10));
    const { memexId } = await makePersonalMemex();
    // The user has already authored one Standard of their own.
    await createDocDraft(memexId, "My own rule", "", "standard");
    expect(await standardDocs(memexId)).toHaveLength(1);

    await seedDefaultStandards(memexId);

    // Still just the user's one — the six defaults were NOT added.
    const after = await standardDocs(memexId);
    expect(after).toHaveLength(1);
    expect(after[0].title).toBe("My own rule");
  });
});

describe("seedDefaultStandards — emits on the unified bus (std-8 / ac-11)", () => {
  it("every seed write goes through mutate(): document/section/clause created events fire", async () => {
    tagAc(AC(11));
    const { memexId } = await makePersonalMemex();

    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe({ memexId }, (e) => {
      events.push(e);
    });
    try {
      await seedDefaultStandards(memexId);
    } finally {
      unsub();
    }

    const docCreated = events.filter((e) => e.entity === "document" && e.action === "created");
    expect(docCreated).toHaveLength(DEFAULT_STANDARDS_COUNT); // one per Standard
    expect(events.some((e) => e.entity === "section" && e.action === "created")).toBe(true);
    expect(events.some((e) => e.entity === "clause" && e.action === "created")).toBe(true);
  });
});

describe("backfillDefaultStandards — empty personal Memexes only (ac-14 / ac-18)", () => {
  it("seeds empty personal Memexes, skips non-empty ones and team Memexes, and is idempotent", async () => {
    tagAc(AC(14));
    tagAc(AC(18));
    tagAc(AC(6)); // scope ac-6: edits/seeding scoped to the user's own Memex

    // Two fresh personal Memexes with empty Standards lists.
    const a = await makePersonalMemex();
    const b = await makePersonalMemex();

    // A personal Memex the user has already started curating (one own Standard).
    const curated = await makePersonalMemex();
    await createDocDraft(curated.memexId, "Curator's rule", "", "standard");

    // A team/org Memex (kind='org') that must NOT be backfilled.
    const orgMemexId = await makeTestMemex("ds-org");
    memexIds.push(orgMemexId);

    const result = await backfillDefaultStandards();

    // Both empty personal Memexes now hold the six defaults.
    expect(await standardDocs(a.memexId)).toHaveLength(6);
    expect(await standardDocs(b.memexId)).toHaveLength(6);
    // The curated personal Memex is untouched — still just the user's one Standard.
    const curatedAfter = await standardDocs(curated.memexId);
    expect(curatedAfter).toHaveLength(1);
    expect(curatedAfter[0].title).toBe("Curator's rule");
    // The org Memex was skipped entirely.
    expect(await standardDocs(orgMemexId)).toHaveLength(0);
    // It reports having seeded the empty personal Memexes (a + b at minimum).
    expect(result.memexesSeeded).toBeGreaterThanOrEqual(2);

    // Idempotent: a second backfill seeds nothing new for a + b.
    await backfillDefaultStandards();
    expect(await standardDocs(a.memexId)).toHaveLength(6);
    expect(await standardDocs(b.memexId)).toHaveLength(6);
    expect(await standardDocs(curated.memexId)).toHaveLength(1);
  });
});

// ── t-6: no marker, no reset surface (dec-3 / ac-12 / ac-13) ─────────────────────

describe("default Standards leave no marker and no reset surface (dec-3)", () => {
  it("no is_default/is_seed marker column on documents; seeded Standards are ordinary rows (ac-12)", async () => {
    tagAc(AC(12));
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'
    `)) as unknown as { column_name: string }[];
    const names = cols.map((c) => c.column_name);
    expect(names.some((n) => /is_default|is_seed/i.test(n))).toBe(false);

    // Seeded Standards carry no demo/seed flag — they are ordinary editable rows.
    const { memexId } = await makePersonalMemex();
    await seedDefaultStandards(memexId);
    const docs = await standardDocs(memexId);
    expect(docs).toHaveLength(6);
    expect(docs.every((d) => d.isDemo === false)).toBe(true);
  });

  it("the service exposes seed + backfill only — no reset/clear/teardown surface (ac-13)", () => {
    tagAc(AC(13));
    const names = Object.keys(defaultStandardsModule);
    expect(names).toEqual(
      expect.arrayContaining(["seedDefaultStandards", "backfillDefaultStandards"]),
    );
    expect(names.some((n) => /reset|clear|teardown|wipe|restore/i.test(n))).toBe(false);
  });

  it("a user's edit to a seeded Standard persists — nothing reverts it (ac-13)", async () => {
    tagAc(AC(13));
    const { memexId } = await makePersonalMemex();
    await seedDefaultStandards(memexId);

    const doc = (await standardDocs(memexId)).find((d) => d.title === DEFAULT_STANDARDS[0].title)!;
    const [ruleSection] = await db
      .select()
      .from(docSections)
      .where(and(eq(docSections.docId, doc.id), eq(docSections.sectionType, "rule")));
    const [firstClause] = await db
      .select()
      .from(standardClauses)
      .where(eq(standardClauses.sectionId, ruleSection.id))
      .orderBy(asc(standardClauses.position))
      .limit(1);

    await updateClause(memexId, firstClause.id, "EDITED BY THE USER.");

    // Re-seeding is the only "restore-ish" path; it must no-op (the Memex already has
    // Standards), so the user's edit stands.
    await seedDefaultStandards(memexId);
    const [reread] = await db
      .select()
      .from(standardClauses)
      .where(eq(standardClauses.id, firstClause.id));
    expect(reread.body).toBe("EDITED BY THE USER.");
  });

  it("a deleted default Standard stays gone — no reset/re-seed brings it back (ac-13)", async () => {
    tagAc(AC(13));
    const { memexId } = await makePersonalMemex();
    await seedDefaultStandards(memexId);
    expect(await standardDocs(memexId)).toHaveLength(6);

    const victim = (await standardDocs(memexId))[0];
    await db.delete(documents).where(eq(documents.id, victim.id)); // user deletes a default

    expect(await standardDocs(memexId)).toHaveLength(5);
    await seedDefaultStandards(memexId); // the only re-seed path — guard sees 5 > 0 → no-op
    const after = await standardDocs(memexId);
    expect(after).toHaveLength(5);
    expect(after.some((d) => d.id === victim.id)).toBe(false);
  });
});
