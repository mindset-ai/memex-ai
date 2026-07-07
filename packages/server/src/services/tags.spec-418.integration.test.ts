// spec-418 t-1 (dec-8) — case-insensitive tag uniqueness + the one-time case-fold.
//
// Proves the CI foundation this Spec's rename/create guards (t-2) build on:
//   * getOrCreateTag matches case-insensitively on scope AND value, first casing wins
//   * the lower(scope), lower(value) expression unique index rejects a case-variant
//   * two tags differing only by case cannot coexist
//   * the migration's fold statements collapse legacy case-variant pairs onto one
//     survivor (most-used, earliest-created tie-break), re-pointing + deduping
//     document_tags, deleting losers, leaving NO orphaned links.
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → emits to the PROD memex; a human runs this.
// Fixture-isolated per std-37 (makeTestMemex mints a unique tenant per suite/case).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { getOrCreateTag } from "./tags.js";
import type { RequestCtx } from "./mutate.js";

const ctx: RequestCtx = {};
const AC = "mindset-prod/memex-building-itself/specs/spec-418/acs";
const CI_INDEX = "tags_memex_scope_value_ci_unique";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, "../../drizzle/0125_spec418_tag_case_fold.sql");

// Source the fold's re-point + delete statements from the SHIPPED migration so this
// test pins the migration's survivor-selection window (PARTITION BY + tie-break),
// never a hand-retyped copy that could drift silently. We take ONLY step 1 (re-point
// INSERT) and step 2 (loser DELETE) — the test owns the CI index (dropped before,
// restored after), so the migration's constraint-swap steps 3 & 4 are skipped. For
// shared-clone isolation (std-37) we inject a single tenant predicate into each step's
// `usage` CTE by deterministic regex; if the migration's shape ever changes so an
// anchor no longer matches, we THROW rather than silently fold across every tenant.
function foldStatementsScopedTo(memexId: string): [string, string] {
  if (!/^[0-9a-f-]{36}$/i.test(memexId)) {
    throw new Error(`refusing to inline non-UUID memexId into raw SQL: ${memexId}`);
  }
  const steps = readFileSync(MIGRATION_PATH, "utf8").split("--> statement-breakpoint");
  const [repoint, del] = steps;
  if (!/INSERT INTO document_tags/.test(repoint) || !/DELETE FROM tags/.test(del)) {
    throw new Error(
      "0125 migration shape changed: expected step 1 = re-point INSERT, step 2 = loser DELETE",
    );
  }
  // Inject `WHERE t.memex_id = '<id>'` into the usage CTE (after the LEFT JOIN,
  // before its GROUP BY) so the shared-clone fold touches only this suite's tenant.
  const anchor = /LEFT JOIN document_tags dt ON dt\.tag_id = t\.id(\r?\n)(\s*)GROUP BY t\.id/;
  const inject = (stmt: string): string => {
    if (!anchor.test(stmt)) {
      throw new Error("0125 usage CTE shape changed: cannot inject tenant predicate");
    }
    return stmt.replace(
      anchor,
      `LEFT JOIN document_tags dt ON dt.tag_id = t.id$1$2WHERE t.memex_id = '${memexId}'$1$2GROUP BY t.id`,
    );
  };
  return [inject(repoint), inject(del)];
}

describe("tags case-insensitive uniqueness [spec-418 t-1]", () => {
  let memexId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("t418ci");
  });

  afterAll(async () => {
    await db.delete(tags).where(eq(tags.memexId, memexId));
  });

  // ── ac-31: getOrCreateTag CI-matches scope AND value, preserves first casing ──
  it("ac-31: getOrCreateTag matches CI on scope AND value; first-written casing preserved", async () => {
    tagAc(`${AC}/ac-31`);

    // Scoped: "area::API" then a full case-variant "AREA::api" → SAME row, "area::API".
    const scoped = await getOrCreateTag(ctx, memexId, "area", "API");
    const scopedVariant = await getOrCreateTag(ctx, memexId, "AREA", "api");
    expect(scopedVariant.id).toBe(scoped.id);
    expect(scopedVariant.scope).toBe("area"); // first writer's scope casing
    expect(scopedVariant.value).toBe("API"); // first writer's value casing

    // Flat (scope = null): "GDPR" then "gdpr" → SAME row, "GDPR".
    const flat = await getOrCreateTag(ctx, memexId, null, "GDPR");
    const flatVariant = await getOrCreateTag(ctx, memexId, null, "gdpr");
    expect(flatVariant.id).toBe(flat.id);
    expect(flatVariant.scope).toBeNull();
    expect(flatVariant.value).toBe("GDPR");
  });

  // ── ac-30: the CI expression unique index (behavioural + introspection) ───────
  it("ac-30: the lower(scope),lower(value) unique index rejects a case-variant insert (23505)", async () => {
    tagAc(`${AC}/ac-30`);

    // Seed "lang::TypeScript"; a raw insert of the case-variant "lang::typescript"
    // in the same Memex must CONFLICT on the CI index (not create a second row).
    await getOrCreateTag(ctx, memexId, "lang", "TypeScript");
    let caught: unknown;
    try {
      await db.insert(tags).values({ memexId, scope: "lang", value: "typescript" });
    } catch (err) {
      caught = err;
    }
    expect(caught, "expected the case-variant insert to be rejected").toBeDefined();
    // drizzle wraps the driver error, so the pg SQLSTATE (23505) rides on `.cause`.
    const pgCode =
      (caught as { code?: string }).code ??
      (caught as { cause?: { code?: string } }).cause?.code;
    expect(pgCode, "expected a 23505 unique-violation on the case-variant insert").toBe("23505");

    // Introspect: an index def over lower(scope) + lower(value), NULLS NOT DISTINCT.
    const idx = (await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'tags'`,
    )) as unknown as Array<{ indexdef: string }>;
    const ci = idx.find(
      (r) =>
        r.indexdef.toLowerCase().includes("lower(scope)") &&
        r.indexdef.toLowerCase().includes("lower(value)"),
    );
    expect(ci, "CI expression unique index missing from pg_indexes").toBeDefined();
    expect(ci!.indexdef.toLowerCase()).toContain("unique");
    expect(ci!.indexdef.toLowerCase()).toContain("nulls not distinct");
  });

  // ── ac-33: create/get of a case-variant returns the existing row ──────────────
  it("ac-33: getOrCreateTag('api') returns the existing row when 'API' already exists", async () => {
    tagAc(`${AC}/ac-33`);
    const orig = await getOrCreateTag(ctx, memexId, "svc", "API");
    const dup = await getOrCreateTag(ctx, memexId, "svc", "api");
    expect(dup.id).toBe(orig.id);
    expect(dup.value).toBe("API");
  });

  // ── ac-26: two tags differing only by case cannot both exist ──────────────────
  it("ac-26: after case-variant creates, only ONE row exists for the CI group", async () => {
    tagAc(`${AC}/ac-26`);
    await getOrCreateTag(ctx, memexId, "env", "Prod");
    await getOrCreateTag(ctx, memexId, "env", "PROD");
    await getOrCreateTag(ctx, memexId, "env", "prod");

    const rows = await db
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.memexId, memexId),
          sql`lower(${tags.scope}) = 'env'`,
          sql`lower(${tags.value}) = 'prod'`,
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe("Prod"); // first writer's casing survives
  });
});

// ── ac-32: the one-time case-fold migration ─────────────────────────────────────
// The migration already ran (globalSetup) before real case-variants exist, so to
// exercise the fold on LEGACY data we DROP the CI index, hand-build case-variant rows,
// run the EXACT fold statements from drizzle/0125_spec418_tag_case_fold.sql (scoped to
// this Memex), then RESTORE the index. Safe because vitest runs files sequentially
// within a worker and each worker owns a private DB clone (std-37).
describe("tag case-fold migration [spec-418 t-1]", () => {
  it("ac-32: folds case-variant pairs onto the most-used/earliest survivor, re-points + dedupes, no orphans", async () => {
    tagAc(`${AC}/ac-32`);
    const memexId = await makeTestMemex("t418fold");

    // Four Specs to spread links across.
    const docIds: Record<string, string> = {};
    for (const h of ["dA", "dB", "dC", "dD"]) {
      const [doc] = await db
        .insert(documents)
        .values({ memexId, handle: `spec-${h}`, title: h, docType: "spec" })
        .returning();
      docIds[h] = doc.id;
    }

    const t = (iso: string) => new Date(iso);
    const mkTag = async (scope: string | null, value: string, createdAt: Date) => {
      const [row] = await db
        .insert(tags)
        .values({ memexId, scope, value, createdAt })
        .returning();
      return row;
    };
    const link = async (tagId: string, ...docs: string[]) => {
      for (const d of docs) {
        await db.insert(documentTags).values({ memexId, docId: docIds[d], tagId });
      }
    };

    try {
      // Drop the CI index so legacy case-variants can be inserted at all.
      await db.execute(sql.raw(`DROP INDEX IF EXISTS ${CI_INDEX}`));

      // SCOPED "most-used" group — survivor is the most-linked variant.
      const S = await mkTag("Area", "API", t("2020-01-01")); // 3 links → survivor
      const L1 = await mkTag("area", "api", t("2020-02-01")); // 2 links
      const L2 = await mkTag("AREA", "Api", t("2020-03-01")); // 1 link
      await link(S.id, "dB", "dC", "dD");
      await link(L1.id, "dA", "dB"); // dA = loser-only; dB carries loser + survivor
      await link(L2.id, "dD"); // dD carries loser + survivor

      // FLAT group (scope = NULL) — proves NULL-scope folding via lower(scope) grouping.
      const FS = await mkTag(null, "GDPR", t("2020-01-01")); // 2 links → survivor
      const FL = await mkTag(null, "gdpr", t("2020-02-01")); // 1 link
      await link(FS.id, "dA", "dC");
      await link(FL.id, "dA"); // dA carries flat loser + flat survivor → dedupe

      // TIE group — equal link counts, earliest created_at wins the tie-break.
      const TS = await mkTag("tier", "Gold", t("2020-01-01")); // 1 link → survivor (earlier)
      const TL = await mkTag("Tier", "gold", t("2020-02-01")); // 1 link
      await link(TS.id, "dC");
      await link(TL.id, "dD");

      // ── Run the EXACT fold statements SOURCED FROM the migration file ──
      // Steps 1 & 2 of drizzle/0125_spec418_tag_case_fold.sql, verbatim except a
      // regex-injected `WHERE t.memex_id = <this memex>` in the usage CTE for
      // shared-clone isolation. Sourcing (not re-typing) pins the survivor window
      // (PARTITION BY + tie-break) to the shipped artifact — see foldStatementsScopedTo.
      const [repointSql, deleteSql] = foldStatementsScopedTo(memexId);
      await db.execute(sql.raw(repointSql));
      await db.execute(sql.raw(deleteSql));

      // ── (i) exactly one survivor row per CI group ──
      const groupRows = async (scopePred: unknown, value: string) =>
        db
          .select()
          .from(tags)
          .where(and(eq(tags.memexId, memexId), scopePred as never, sql`lower(${tags.value}) = ${value}`));

      const areaGroup = await groupRows(sql`lower(${tags.scope}) = 'area'`, "api");
      const flatGroup = await groupRows(isNull(tags.scope), "gdpr");
      const tierGroup = await groupRows(sql`lower(${tags.scope}) = 'tier'`, "gold");
      expect(areaGroup.length).toBe(1);
      expect(flatGroup.length).toBe(1);
      expect(tierGroup.length).toBe(1);

      // ── (ii) survivor is the most-used / earliest one ──
      expect(areaGroup[0].id).toBe(S.id);
      expect(flatGroup[0].id).toBe(FS.id);
      expect(tierGroup[0].id).toBe(TS.id); // earliest-created won the count tie

      // ── (v) loser tag rows deleted ──
      const survivors = new Set([S.id, FS.id, TS.id]);
      const remaining = await db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.memexId, memexId));
      expect(remaining.map((r) => r.id).sort()).toEqual([...survivors].sort());

      // ── (iii) every prior loser link now points to a survivor, NO duplicate ──
      const allLinks = await db
        .select({ docId: documentTags.docId, tagId: documentTags.tagId })
        .from(documentTags)
        .where(eq(documentTags.memexId, memexId));

      // No (doc, tag) duplicated (unique(document_id, tag_id) holds).
      const pairKeys = allLinks.map((l) => `${l.docId}:${l.tagId}`);
      expect(new Set(pairKeys).size).toBe(pairKeys.length);

      // Every link points to a survivor.
      for (const l of allLinks) expect(survivors.has(l.tagId)).toBe(true);

      // Doc-level end state matches the expected fold.
      const tagsOnDoc = (h: string) =>
        allLinks.filter((l) => l.docId === docIds[h]).map((l) => l.tagId).sort();
      expect(tagsOnDoc("dA")).toEqual([S.id, FS.id].sort());
      expect(tagsOnDoc("dB")).toEqual([S.id].sort());
      expect(tagsOnDoc("dC")).toEqual([S.id, FS.id, TS.id].sort());
      expect(tagsOnDoc("dD")).toEqual([S.id, TS.id].sort());

      // ── (iv) ZERO orphaned document_tags (every tag_id still exists in tags) ──
      const orphans = (await db.execute(sql`
        SELECT count(*)::int AS n
        FROM document_tags dt
        LEFT JOIN tags t ON t.id = dt.tag_id
        WHERE dt.memex_id = ${memexId} AND t.id IS NULL
      `)) as unknown as Array<{ n: number }>;
      expect(orphans[0].n).toBe(0);
    } finally {
      // Restore the CI index for subsequent files in this worker's DB clone.
      await db.execute(
        sql.raw(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${CI_INDEX} ON tags (memex_id, lower(scope), lower(value)) NULLS NOT DISTINCT`,
        ),
      );
      // Fixture cleanup (documents cascade to document_tags; tags removed explicitly).
      for (const d of Object.values(docIds)) await db.delete(documents).where(eq(documents.id, d));
      await db.delete(tags).where(eq(tags.memexId, memexId));
    }
  });
});
