// spec-522 t-1 — the decisions and issues FTS arms are index-served, not
// sequential scans.
//
// WHAT WAS WRONG. Both arms built `to_tsvector(...)` inline, per row and TWICE
// (once in the WHERE predicate, once inside ts_rank), across every row in the
// Memex on every settled ⌘K keystroke. Measured against live prod on 2026-08-06
// (spec-522 s-2): a `?kind=decision` search cost 784 ms p50 versus 354–439 ms for
// every other single-embed arm, and sat within 26 ms of the full six-arm search —
// so this one arm WAS the critical path of ⌘K. A query matching zero rows still
// cost 746 ms.
//
// WHY THE ac-8 TEST ASSERTS A QUERY PLAN, NOT A DURATION. The AC is about a
// ~390 ms gap closing, and the obvious test — time the two arms and compare — is
// exactly the kind of wall-clock assertion that goes flaky on a loaded CI box and
// then gets quarantined. The plan is the *cause* the duration was a symptom of:
// if the predicate is served by a Bitmap Index Scan on the GIN index rather than
// a Seq Scan, the per-row tokenisation is gone by construction. So this asserts
// the plan and lets the deployed re-measurement (t-7, ac-2) own the number.
//
// WHY ac-9 RECOMPUTES THE OLD EXPRESSION LITERALLY. Result parity is the sharp
// edge of this whole change: ts_rank over a materialised column is only identical
// to the old inline expression if the concatenation, the coalesce handling and
// the text-search config all match exactly. Rather than trust that reading, these
// tests recompute the PRE-0132 expression in SQL and demand equivalence — both
// for the tsvector itself and for the ts_rank score it feeds, because it is the
// score that decides result ORDER.
//
// Parity is asserted twice over: whole-table (every row in the database must
// agree, catching anything any other suite has seeded) and over rows this file
// seeds itself (so the check can never pass vacuously on an empty table).
//
// std-37: seeds under a per-worker-unique memex and deletes only its own docs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { createIssue } from "./issues.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

let memexId: string;
let devUserId: string;

/** Strip `//` line comments so a source scan asserts on CODE, not on prose that
 *  legitimately names the anti-pattern it warns future readers away from. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s522fts");
  memexId = made.memexId;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;

  const doc = await createDocDraft(
    memexId,
    "Quibbleflex retrieval latency",
    "The quibbleflex purpose.",
    "spec",
    undefined,
    undefined,
    devUserId,
    REST,
  );
  createdDocIds.push(doc.id);

  // Deliberately exercise every branch of the generated expression:
  //  - a RESOLVED decision  -> title + context + resolution all non-empty
  //  - an OPEN decision     -> resolution is NULL, so coalesce(...,'') is load-bearing
  // If the materialised expression got the NULL handling wrong, the open one is
  // where it shows up.
  const resolved = await createDecision(
    memexId,
    doc.id,
    "Which quibbleflex cache do we use?",
    "quibbleflex context about caching and retrieval",
    "human",
    REST,
  );
  await resolveDecision(memexId, resolved.id, "A bounded quibbleflex map.", undefined, REST);

  await createDecision(
    memexId,
    doc.id,
    "How is the quibbleflex vector obtained?",
    "quibbleflex context with no resolution yet",
    "human",
    REST,
  );

  // Same for issues, except `issues.body` is NOT NULL (unlike
  // `decisions.resolution`), so the empty-string case — not the NULL one — is the
  // edge that can actually occur. It still exercises the `|| ' ' ||` join with an
  // empty operand, which is where a mis-ordered concatenation would show up.
  await createIssue({
    memexId,
    docId: doc.id,
    title: "Quibbleflex search is slow",
    body: "The quibbleflex arm scans sequentially on every keystroke.",
    type: "bug",
    createdByUserId: devUserId,
  });
  await createIssue({
    memexId,
    docId: doc.id,
    title: "Quibbleflex telemetry gap",
    body: "",
    type: "todo",
    createdByUserId: devUserId,
  });
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-522 — decisions/issues FTS is index-served (ac-7, ac-8, ac-9)", () => {
  it("both tables carry a STORED generated content_tsv column with a GIN index", async () => {
    tagAc(AC(7));

    const cols = (await db.execute(sql`
      SELECT table_name, is_generated, generation_expression
      FROM information_schema.columns
      WHERE column_name = 'content_tsv'
        AND table_name IN ('decisions', 'issues')
      ORDER BY table_name
    `)) as unknown as {
      table_name: string;
      is_generated: string;
      generation_expression: string;
    }[];

    expect(cols.map((c) => c.table_name)).toEqual(["decisions", "issues"]);
    for (const c of cols) {
      expect(c.is_generated).toBe("ALWAYS");
      // The stored expression must use the immutable two-arg regconfig form —
      // to_tsvector(text, text) is only STABLE and Postgres rejects it outright
      // in a generated column. Pinning it here records WHY the cast is there, so
      // nobody "tidies" it away and hits a confusing migration failure.
      expect(c.generation_expression).toContain("'english'::regconfig");
    }

    const idx = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('decisions_content_tsv_idx', 'issues_content_tsv_idx')
      ORDER BY indexname
    `)) as unknown as { indexname: string; indexdef: string }[];

    expect(idx.map((i) => i.indexname)).toEqual([
      "decisions_content_tsv_idx",
      "issues_content_tsv_idx",
    ]);
    for (const i of idx) expect(i.indexdef).toContain("USING gin");
  });

  it("neither FTS arm builds a tsvector at query time", () => {
    tagAc(AC(7));

    const src = codeOnly(
      readFileSync(resolve(__dirname, "memex-search/retrieval.ts"), "utf8"),
    );

    // The whole point: no per-row tokenisation anywhere in the executable SQL.
    expect(src).not.toContain("to_tsvector");

    // And the arms positively read the materialised column, in the predicate AND
    // in ts_rank — an index on the predicate alone would still leave ts_rank
    // recomputing for every matched row.
    expect(src).toContain("dec.content_tsv @@");
    expect(src).toContain("ts_rank(dec.content_tsv,");
    expect(src).toContain("iss.content_tsv @@");
    expect(src).toContain("ts_rank(iss.content_tsv,");
  });

  it("a zero-match query is INDEX-SERVABLE on both tables — the GIN index answers the predicate", async () => {
    tagAc(AC(8));
    // ac-5 is the scope-level statement of the same outcome: search does no
    // per-row work proportional to the number of decisions or issues.
    tagAc(AC(5));

    // WHY enable_seqscan=off RATHER THAN A NAKED EXPLAIN. This suite's tables hold
    // a handful of rows, and on a handful of rows a Seq Scan is genuinely the
    // cheapest plan — Postgres is right to pick it, and it is fast. Asserting
    // "must not seq scan" here would assert the planner's COST MODEL against a toy
    // corpus, and would fail for a reason that has nothing to do with this change.
    //
    // What ac-8 actually needs is that the predicate CAN be answered from the
    // index — i.e. that `content_tsv @@ tsquery` matches the GIN index rather than
    // requiring per-row tokenisation. Discouraging seqscan isolates exactly that:
    // enable_seqscan=off is a cost penalty, not a prohibition, so if the index did
    // not apply Postgres would still fall back to a Seq Scan and this would fail.
    //
    // The at-scale evidence lives elsewhere, deliberately: against the 3,546-row
    // dev database this change took a zero-match decisions query from a 223.8 ms
    // Seq Scan to a 0.069 ms Bitmap Index Scan, and t-7 (ac-2) re-measures the
    // deployed environment. Wall-clock belongs there, not in a unit suite.
    //
    // SET LOCAL needs a transaction, and a transaction also pins every statement
    // to one pooled connection — without it the SET and the EXPLAIN could land on
    // different connections and the setting would silently not apply.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);

      for (const [table, alias] of [
        ["decisions", "dec"],
        ["issues", "iss"],
      ] as const) {
        const plan = (await tx.execute(
          sql`EXPLAIN (ANALYZE, FORMAT TEXT)
              SELECT ${sql.raw(alias)}.id
              FROM ${sql.raw(table)} ${sql.raw(alias)}
              WHERE ${sql.raw(alias)}.content_tsv @@ plainto_tsquery('english', 'zzqqxxvv')
              LIMIT 50`,
        )) as unknown as Record<string, string>[];

        const text = plan.map((r) => Object.values(r)[0]).join("\n");

        expect(text, `${table} plan`).toContain(`${table}_content_tsv_idx`);
        expect(text, `${table} plan`).toMatch(/Bitmap Index Scan|Index Scan/);
      }
    });
  });

  it("the materialised tsvector is identical to the expression it replaced, for every row", async () => {
    tagAc(AC(9));

    // Recompute the PREVIOUS inline expression verbatim (from the pre-0132
    // retrieval.ts) and demand whole-table equivalence. `IS DISTINCT FROM`
    // rather than `<>` so NULL compares correctly instead of vanishing.
    const rows = (await db.execute(sql`
      SELECT 'decisions' AS tbl,
             count(*) AS total,
             count(*) FILTER (
               WHERE content_tsv IS DISTINCT FROM to_tsvector('english',
                 coalesce(title, '') || ' ' ||
                 coalesce(context, '') || ' ' ||
                 coalesce(resolution, ''))
             ) AS mismatches
      FROM decisions
      UNION ALL
      SELECT 'issues',
             count(*),
             count(*) FILTER (
               WHERE content_tsv IS DISTINCT FROM to_tsvector('english',
                 coalesce(title, '') || ' ' ||
                 coalesce(body, ''))
             )
      FROM issues
    `)) as unknown as { tbl: string; total: string; mismatches: string }[];

    for (const r of rows) {
      expect(Number(r.mismatches), `${r.tbl} tsvector parity`).toBe(0);
    }

    // Whole-table parity passes vacuously on an empty table, so pin it to the
    // rows this file seeded — including the NULL-resolution and empty-body ones,
    // which are where a botched coalesce or a mis-ordered concatenation surfaces.
    const own = (await db.execute(sql`
      SELECT
        (SELECT count(*) FROM decisions WHERE memex_id = ${memexId}) AS decs,
        (SELECT count(*) FROM issues    WHERE memex_id = ${memexId}) AS isss,
        (SELECT count(*) FROM decisions WHERE memex_id = ${memexId} AND resolution IS NULL) AS open_decs,
        (SELECT count(*) FROM issues    WHERE memex_id = ${memexId} AND body = '') AS bodyless
    `)) as unknown as {
      decs: string;
      isss: string;
      open_decs: string;
      bodyless: string;
    }[];

    expect(Number(own[0].decs)).toBeGreaterThanOrEqual(2);
    expect(Number(own[0].isss)).toBeGreaterThanOrEqual(2);
    expect(Number(own[0].open_decs)).toBeGreaterThanOrEqual(1);
    expect(Number(own[0].bodyless)).toBeGreaterThanOrEqual(1);
  });

  it("ts_rank over the stored column scores identically to the old inline expression", async () => {
    tagAc(AC(9));
    // ac-3 is the scope-level commitment this protects: the same query returns
    // the same hits in the same order. ts_rank is what decides that order.
    tagAc(AC(3));

    // Tsvector parity is necessary but not sufficient for ac-3: ts_rank is what
    // ORDERS results, so assert the scores match too — over rows that actually
    // match, otherwise every score is 0 and the comparison proves nothing.
    const rows = (await db.execute(sql`
      SELECT count(*) FILTER (
               WHERE ts_rank(content_tsv, plainto_tsquery('english', 'quibbleflex'))
                 IS DISTINCT FROM
                 ts_rank(to_tsvector('english',
                   coalesce(title, '') || ' ' ||
                   coalesce(context, '') || ' ' ||
                   coalesce(resolution, '')),
                   plainto_tsquery('english', 'quibbleflex'))
             ) AS rank_mismatches,
             count(*) FILTER (
               WHERE content_tsv @@ plainto_tsquery('english', 'quibbleflex')
             ) AS matched
      FROM decisions
      WHERE memex_id = ${memexId}
    `)) as unknown as { rank_mismatches: string; matched: string }[];

    expect(Number(rows[0].rank_mismatches)).toBe(0);
    expect(Number(rows[0].matched)).toBeGreaterThan(0);
  });
});
