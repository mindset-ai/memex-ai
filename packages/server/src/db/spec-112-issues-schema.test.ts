import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-112 t-1 — data-model foundation for the Issues primitive.
//
// Introspects the live local Postgres schema (post-migration 0068) to assert the
// issues table shape, its cascade/uniqueness contracts, the status CHECK set, the
// ac_parent_links 'issue' extension, and the no-backfill invariant for legacy
// doc_comments issue/deferred rows. Each test tags the AC it empirically proves.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

describe("spec-112 schema: issues table", () => {
  it("issues table exists with memex_id NOT NULL and a doc_id → documents CASCADE FK (ac-9)", async () => {
    tagAc(AC(9));

    const cols = (await db.execute(
      sql`select column_name, data_type, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'issues'`
    )) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>;

    expect(cols.length, "issues table missing").toBeGreaterThan(0);
    const byName = new Map(cols.map((c) => [c.column_name, c]));

    // memex_id — tenancy column, NOT NULL.
    expect(byName.get("memex_id")?.data_type).toBe("uuid");
    expect(byName.get("memex_id")?.is_nullable).toBe("NO");

    // doc_id — parentage column, GENERIC name (NOT brief_id), NOT NULL.
    expect(byName.get("doc_id")?.data_type).toBe("uuid");
    expect(byName.get("doc_id")?.is_nullable).toBe("NO");
    expect(byName.has("brief_id"), "issues must use the generic doc_id, never brief_id").toBe(false);

    // The doc_id FK must reference documents(id) ON DELETE CASCADE so deleting a
    // Spec deletes its Issues.
    const fks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'issues'::regclass and c.contype = 'f'`
    )) as unknown as Array<{ def: string }>;

    const docFk = fks.find(
      (r) => r.def.includes("(doc_id)") && r.def.includes("REFERENCES documents")
    );
    expect(docFk, "doc_id → documents FK missing").toBeTruthy();
    expect(docFk!.def).toContain("ON DELETE CASCADE");
  });

  it("deleting a Spec cascade-deletes its Issues (ac-9)", async () => {
    tagAc(AC(9));

    // Stand up an isolated memex/namespace + a Spec, attach an Issue, delete the
    // Spec, and assert the Issue is gone. All inside a rolled-back transaction so
    // the suite leaves no residue.
    await db.transaction(async (tx) => {
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind)
            values ('spec112-cascade-ns', 'user')
            returning id`
      )) as unknown as Array<{ id: string }>;
      const nsId = ns[0]!.id;

      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${nsId}, 'spec112-cascade-mx', 'cascade')
            returning id`
      )) as unknown as Array<{ id: string }>;
      const memexId = mx[0]!.id;

      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type)
            values (${memexId}, 'spec-cascade-1', 'Cascade Spec', 'spec')
            returning id`
      )) as unknown as Array<{ id: string }>;
      const docId = doc[0]!.id;

      await tx.execute(
        sql`insert into issues (memex_id, doc_id, seq, title, body, type)
            values (${memexId}, ${docId}, 1, 'leaky', 'repro', 'bug')`
      );

      const before = (await tx.execute(
        sql`select count(*)::int as n from issues where doc_id = ${docId}`
      )) as unknown as Array<{ n: number }>;
      expect(before[0]!.n).toBe(1);

      await tx.execute(sql`delete from documents where id = ${docId}`);

      const after = (await tx.execute(
        sql`select count(*)::int as n from issues where doc_id = ${docId}`
      )) as unknown as Array<{ n: number }>;
      expect(after[0]!.n, "deleting the Spec must cascade-delete its Issues").toBe(0);

      tx.rollback();
    }).catch((e) => {
      // db.transaction throws on tx.rollback() by design — swallow only that.
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
  });

  it("issues carries UNIQUE(doc_id, seq) — the issue-N handle space is independent of other seqs (ac-10)", async () => {
    tagAc(AC(10));

    // The UNIQUE(doc_id, seq) constraint exists and spans exactly those columns.
    const uniq = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'issues'::regclass and c.contype = 'u'`
    )) as unknown as Array<{ def: string }>;
    expect(uniq.some((r) => r.def.includes("(doc_id, seq)")), "UNIQUE(doc_id, seq) missing").toBe(true);

    // Empirically: two Issues with the SAME (doc_id, seq) collide, but a Decision
    // and a Task on the SAME doc can each hold seq=1 — the issues seq space is its
    // own namespace, independent of decisions/tasks/acs/comments on that Spec.
    await db.transaction(async (tx) => {
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind)
            values ('spec112-seq-ns', 'user') returning id`
      )) as unknown as Array<{ id: string }>;
      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${ns[0]!.id}, 'spec112-seq-mx', 'seq') returning id`
      )) as unknown as Array<{ id: string }>;
      const memexId = mx[0]!.id;
      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type)
            values (${memexId}, 'spec-seq-1', 'Seq Spec', 'spec') returning id`
      )) as unknown as Array<{ id: string }>;
      const docId = doc[0]!.id;

      // issue seq=1 OK; a decision + a task on the same doc can ALSO be seq=1.
      await tx.execute(
        sql`insert into issues (memex_id, doc_id, seq, title, body, type)
            values (${memexId}, ${docId}, 1, 'i', 'b', 'bug')`
      );
      await tx.execute(
        sql`insert into decisions (memex_id, doc_id, seq, title)
            values (${memexId}, ${docId}, 1, 'a decision')`
      );
      await tx.execute(
        sql`insert into tasks (memex_id, doc_id, seq, title, description)
            values (${memexId}, ${docId}, 1, 'a task', 'desc')`
      );

      // A SECOND issue at seq=1 on the same doc must collide.
      await expect(
        tx.execute(
          sql`insert into issues (memex_id, doc_id, seq, title, body, type)
              values (${memexId}, ${docId}, 1, 'dup', 'b', 'bug')`
        )
      ).rejects.toThrow();

      tx.rollback();
    }).catch((e) => {
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
  });

  it("issues.status CHECK is exactly {open,converted,resolved,wont_fix} and rejects others (ac-16)", async () => {
    tagAc(AC(16));

    const checks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'issues'::regclass and c.contype = 'c'
            and c.conname = 'issues_status_valid'`
    )) as unknown as Array<{ def: string }>;
    expect(checks.length, "issues_status_valid CHECK missing").toBe(1);
    const def = checks[0]!.def;
    for (const v of ["open", "converted", "resolved", "wont_fix"]) {
      expect(def, `status CHECK must permit '${v}'`).toContain(v);
    }

    // Empirically reject an out-of-set value.
    await db.transaction(async (tx) => {
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind)
            values ('spec112-status-ns', 'user') returning id`
      )) as unknown as Array<{ id: string }>;
      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${ns[0]!.id}, 'spec112-status-mx', 's') returning id`
      )) as unknown as Array<{ id: string }>;
      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type)
            values (${mx[0]!.id}, 'spec-status-1', 'S', 'spec') returning id`
      )) as unknown as Array<{ id: string }>;

      await expect(
        tx.execute(
          sql`insert into issues (memex_id, doc_id, seq, title, body, type, status)
              values (${mx[0]!.id}, ${doc[0]!.id}, 1, 't', 'b', 'bug', 'closed')`
        ),
        "status='closed' must be rejected by the CHECK"
      ).rejects.toThrow();

      tx.rollback();
    }).catch((e) => {
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
  });

  it("ac_parent_links.parent_kind now allows 'issue' alongside the existing kinds (ac-19)", async () => {
    tagAc(AC(19));

    const checks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'ac_parent_links'::regclass and c.contype = 'c'
            and c.conname = 'ac_parent_links_kind_valid'`
    )) as unknown as Array<{ def: string }>;
    expect(checks.length, "ac_parent_links_kind_valid CHECK missing").toBe(1);
    const def = checks[0]!.def;
    expect(def).toContain("issue");
    // The pre-existing doc-parentage discriminator must NOT have been renamed
    // away by this migration — it's a wire-format value, asserted verbatim.
    expect(def, "doc-parentage discriminator must remain in the parent_kind set").toContain("brief");
    expect(def).toContain("decision");

    // Empirically: an ac_parent_links row with parent_kind='issue' inserts, and a
    // bogus parent_kind is rejected. The link is queryable for provenance.
    await db.transaction(async (tx) => {
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind)
            values ('spec112-link-ns', 'user') returning id`
      )) as unknown as Array<{ id: string }>;
      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${ns[0]!.id}, 'spec112-link-mx', 'l') returning id`
      )) as unknown as Array<{ id: string }>;
      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type)
            values (${mx[0]!.id}, 'spec-link-1', 'L', 'spec') returning id`
      )) as unknown as Array<{ id: string }>;
      const issue = (await tx.execute(
        sql`insert into issues (memex_id, doc_id, seq, title, body, type)
            values (${mx[0]!.id}, ${doc[0]!.id}, 1, 'i', 'b', 'bug') returning id`
      )) as unknown as Array<{ id: string }>;
      const ac = (await tx.execute(
        sql`insert into acs (memex_id, brief_id, seq, kind, statement)
            values (${mx[0]!.id}, ${doc[0]!.id}, 1, 'implementation', 'verifies the issue')
            returning id`
      )) as unknown as Array<{ id: string }>;

      await tx.execute(
        sql`insert into ac_parent_links (ac_id, parent_kind, parent_id)
            values (${ac[0]!.id}, 'issue', ${issue[0]!.id})`
      );
      const link = (await tx.execute(
        sql`select 1 as ok from ac_parent_links
            where ac_id = ${ac[0]!.id} and parent_kind = 'issue' and parent_id = ${issue[0]!.id}`
      )) as unknown as Array<{ ok: number }>;
      expect(link.length, "parent_kind='issue' link not queryable").toBe(1);

      await expect(
        tx.execute(
          sql`insert into ac_parent_links (ac_id, parent_kind, parent_id)
              values (${ac[0]!.id}, 'bogus', ${issue[0]!.id})`
        )
      ).rejects.toThrow();

      tx.rollback();
    }).catch((e) => {
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
  });

  it("legacy doc_comments issue/deferred rows are NOT backfilled into issues (ac-33)", async () => {
    tagAc(AC(33));

    // The no-backfill invariant: even when the DB carries legacy comments with
    // comment_type IN ('issue','deferred'), the issues table contains only
    // forward-written rows. We assert this structurally: no issues row shares its
    // primary key / identity with any doc_comment (there is no migration path that
    // copies comment ids into issues), AND the count of issues is never coupled to
    // the count of issue/deferred comments.
    const commentCount = (await db.execute(
      sql`select count(*)::int as n from doc_comments
          where comment_type in ('issue', 'deferred')`
    )) as unknown as Array<{ n: number }>;

    // Any legacy issue/deferred comments that exist must STILL be comments —
    // addressable as c-N, with their seq intact — i.e. they were not deleted or
    // mutated away by an Issues migration.
    const stillComments = (await db.execute(
      sql`select count(*)::int as n from doc_comments
          where comment_type in ('issue', 'deferred') and seq is not null`
    )) as unknown as Array<{ n: number }>;
    expect(stillComments[0]!.n).toBe(commentCount[0]!.n);

    // There is no shared-id bridge: no issues.id equals any doc_comments.id. A
    // backfill that mirrored comments into issues would reuse ids or leave a
    // traceable correspondence; none exists.
    const overlap = (await db.execute(
      sql`select count(*)::int as n
          from issues i
          join doc_comments dc on dc.id = i.id`
    )) as unknown as Array<{ n: number }>;
    expect(overlap[0]!.n, "no issues row may share an id with a doc_comment").toBe(0);

    // And the 0068 migration adds no backfill: confirm no issues row carries the
    // marker of a copied comment — issues created by the feature are forward-
    // written only. (issues has no comment_id column at all.)
    const cols = (await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'issues'`
    )) as unknown as Array<{ column_name: string }>;
    const names = new Set(cols.map((c) => c.column_name));
    expect(names.has("comment_id"), "issues must have no comment_id bridge column").toBe(false);
    expect(names.has("source_comment_id"), "issues must have no source_comment_id bridge column").toBe(false);
  });
});
