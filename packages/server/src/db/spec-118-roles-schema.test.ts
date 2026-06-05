import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-118 t-1 — data-model foundation for per-Spec roles + assignment.
//
// Introspects the live local Postgres schema (post-migration 0069) to assert the
// doc_members / doc_assignees table shapes, their cascade + uniqueness contracts,
// and the role CHECK set. Each test tags the AC it empirically proves.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

// Stand up an isolated namespace + memex + Spec + two users inside a tx, run the
// body, then roll back so the suite leaves no residue. Mirrors the spec-112
// schema-test fixtures.
async function withFixture(
  body: (tx: any, ids: { memexId: string; docId: string; userA: string; userB: string }) => Promise<void>,
) {
  await db
    .transaction(async (tx) => {
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind) values ('spec118-ns', 'user') returning id`,
      )) as unknown as Array<{ id: string }>;
      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${ns[0]!.id}, 'spec118-mx', 'roles') returning id`,
      )) as unknown as Array<{ id: string }>;
      const memexId = mx[0]!.id;
      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type)
            values (${memexId}, 'spec-roles-1', 'Roles Spec', 'spec') returning id`,
      )) as unknown as Array<{ id: string }>;
      const ua = (await tx.execute(
        sql`insert into users (email) values ('spec118-a@example.com') returning id`,
      )) as unknown as Array<{ id: string }>;
      const ub = (await tx.execute(
        sql`insert into users (email) values ('spec118-b@example.com') returning id`,
      )) as unknown as Array<{ id: string }>;
      await body(tx, { memexId, docId: doc[0]!.id, userA: ua[0]!.id, userB: ub[0]!.id });
      tx.rollback();
    })
    .catch((e) => {
      // db.transaction throws on tx.rollback() by design — swallow only that.
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
}

describe("spec-118 schema: doc_members table", () => {
  it("doc_members exists with memex_id NOT NULL + doc_id/user_id CASCADE FKs and UNIQUE(doc_id,user_id) (ac-7)", async () => {
    tagAc(AC(7));

    const cols = (await db.execute(
      sql`select column_name, data_type, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'doc_members'`,
    )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    expect(cols.length, "doc_members table missing").toBeGreaterThan(0);
    const byName = new Map(cols.map((c) => [c.column_name, c]));

    expect(byName.get("memex_id")?.data_type).toBe("uuid");
    expect(byName.get("memex_id")?.is_nullable).toBe("NO");
    expect(byName.get("doc_id")?.data_type).toBe("uuid");
    expect(byName.get("doc_id")?.is_nullable).toBe("NO");
    expect(byName.get("user_id")?.data_type).toBe("uuid");
    expect(byName.get("user_id")?.is_nullable).toBe("NO");
    expect(byName.get("role")?.is_nullable).toBe("NO");

    const fks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'doc_members'::regclass and c.contype = 'f'`,
    )) as unknown as Array<{ def: string }>;
    const docFk = fks.find((r) => r.def.includes("(doc_id)") && r.def.includes("REFERENCES documents"));
    expect(docFk, "doc_id → documents FK missing").toBeTruthy();
    expect(docFk!.def).toContain("ON DELETE CASCADE");
    const userFk = fks.find((r) => r.def.includes("(user_id)") && r.def.includes("REFERENCES users"));
    expect(userFk, "user_id → users FK missing").toBeTruthy();
    expect(userFk!.def).toContain("ON DELETE CASCADE");

    const uniq = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'doc_members'::regclass and c.contype = 'u'`,
    )) as unknown as Array<{ def: string }>;
    expect(uniq.some((r) => r.def.includes("(doc_id, user_id)")), "UNIQUE(doc_id,user_id) missing").toBe(true);
  });

  // NOTE: a statement error aborts the surrounding Postgres transaction, so each
  // deliberate-failure assertion is the LAST statement in its own fixture.

  it("a duplicate (doc_id,user_id) collides on the UNIQUE constraint (ac-7)", async () => {
    tagAc(AC(7));
    await withFixture(async (tx, { memexId, docId, userA }) => {
      await tx.execute(
        sql`insert into doc_members (memex_id, doc_id, user_id, role)
            values (${memexId}, ${docId}, ${userA}, 'editor')`,
      );
      // Deliberate failure, last statement before rollback.
      await expect(
        tx.execute(
          sql`insert into doc_members (memex_id, doc_id, user_id, role)
              values (${memexId}, ${docId}, ${userA}, 'editor')`,
        ),
      ).rejects.toThrow();
    });
  });

  it("deleting the user cascade-removes its membership row (ac-7)", async () => {
    tagAc(AC(7));
    await withFixture(async (tx, { memexId, docId, userA }) => {
      await tx.execute(
        sql`insert into doc_members (memex_id, doc_id, user_id, role)
            values (${memexId}, ${docId}, ${userA}, 'editor')`,
      );
      await tx.execute(sql`delete from users where id = ${userA}`);
      const n = (await tx.execute(
        sql`select count(*)::int as n from doc_members where doc_id = ${docId}`,
      )) as unknown as Array<{ n: number }>;
      expect(n[0]!.n, "deleting the user must cascade-delete its membership").toBe(0);
    });
  });

  it("deleting the Spec cascade-removes its membership rows (ac-7)", async () => {
    tagAc(AC(7));
    await withFixture(async (tx, { memexId, docId, userB }) => {
      await tx.execute(
        sql`insert into doc_members (memex_id, doc_id, user_id, role)
            values (${memexId}, ${docId}, ${userB}, 'editor')`,
      );
      await tx.execute(sql`delete from documents where id = ${docId}`);
      const n = (await tx.execute(
        sql`select count(*)::int as n from doc_members where doc_id = ${docId}`,
      )) as unknown as Array<{ n: number }>;
      expect(n[0]!.n, "deleting the Spec must cascade-delete its membership").toBe(0);
    });
  });

  it("doc_members.role CHECK is exactly {editor,reviewer} and rejects others (ac-8)", async () => {
    tagAc(AC(8));

    const checks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'doc_members'::regclass and c.contype = 'c'
            and c.conname = 'doc_members_role_valid'`,
    )) as unknown as Array<{ def: string }>;
    expect(checks.length, "doc_members_role_valid CHECK missing").toBe(1);
    expect(checks[0]!.def).toContain("editor");
    expect(checks[0]!.def).toContain("reviewer");

    await withFixture(async (tx, { memexId, docId, userA, userB }) => {
      // A valid role inserts (userA).
      await tx.execute(
        sql`insert into doc_members (memex_id, doc_id, user_id, role)
            values (${memexId}, ${docId}, ${userA}, 'editor')`,
      );
      // An out-of-set role on a DIFFERENT user is rejected by the CHECK (not by the
      // unique constraint) — last statement before rollback.
      await expect(
        tx.execute(
          sql`insert into doc_members (memex_id, doc_id, user_id, role)
              values (${memexId}, ${docId}, ${userB}, 'admin')`,
        ),
        "role='admin' must be rejected by the CHECK",
      ).rejects.toThrow();
    });
  });
});

describe("spec-118 schema: doc_assignees table", () => {
  it("doc_assignees exists with CASCADE FKs, UNIQUE(doc_id,user_id), and allows multiple assignees per Spec (ac-11)", async () => {
    tagAc(AC(11));

    const cols = (await db.execute(
      sql`select column_name, data_type, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'doc_assignees'`,
    )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    expect(cols.length, "doc_assignees table missing").toBeGreaterThan(0);
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get("memex_id")?.is_nullable).toBe("NO");
    expect(byName.get("doc_id")?.is_nullable).toBe("NO");
    expect(byName.get("user_id")?.is_nullable).toBe("NO");
    // assigned_by is nullable (ON DELETE SET NULL keeps the assignment when the actor is removed).
    expect(byName.get("assigned_by")?.is_nullable).toBe("YES");

    const fks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'doc_assignees'::regclass and c.contype = 'f'`,
    )) as unknown as Array<{ def: string }>;
    expect(
      fks.some((r) => r.def.includes("(doc_id)") && r.def.includes("REFERENCES documents") && r.def.includes("ON DELETE CASCADE")),
      "doc_id → documents CASCADE FK missing",
    ).toBe(true);
    expect(
      fks.some((r) => r.def.includes("(user_id)") && r.def.includes("REFERENCES users") && r.def.includes("ON DELETE CASCADE")),
      "user_id → users CASCADE FK missing",
    ).toBe(true);
    expect(
      fks.some((r) => r.def.includes("(assigned_by)") && r.def.includes("ON DELETE SET NULL")),
      "assigned_by → users SET NULL FK missing",
    ).toBe(true);

    const uniq = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'doc_assignees'::regclass and c.contype = 'u'`,
    )) as unknown as Array<{ def: string }>;
    expect(uniq.some((r) => r.def.includes("(doc_id, user_id)")), "UNIQUE(doc_id,user_id) missing").toBe(true);

    await withFixture(async (tx, { memexId, docId, userA, userB }) => {
      // Two DIFFERENT users assigned to the same Spec — one-or-more assignees.
      await tx.execute(
        sql`insert into doc_assignees (memex_id, doc_id, user_id) values (${memexId}, ${docId}, ${userA})`,
      );
      await tx.execute(
        sql`insert into doc_assignees (memex_id, doc_id, user_id) values (${memexId}, ${docId}, ${userB})`,
      );
      const n = (await tx.execute(
        sql`select count(*)::int as n from doc_assignees where doc_id = ${docId}`,
      )) as unknown as Array<{ n: number }>;
      expect(n[0]!.n, "a Spec must support multiple assignees").toBe(2);

      // The SAME user assigned twice collides on UNIQUE(doc_id,user_id).
      await expect(
        tx.execute(
          sql`insert into doc_assignees (memex_id, doc_id, user_id) values (${memexId}, ${docId}, ${userA})`,
        ),
      ).rejects.toThrow();
    });
  });
});

describe("spec-118: roles are capability/UI-mode only — no visibility table (ac-10)", () => {
  it("introduces NO per-Memex / per-Spec visibility table (std-4's forbidden thing) (ac-10)", async () => {
    tagAc(AC(10));
    // std-4: the only access gate is org-level (org_memberships); a per-Memex/per-Spec
    // visibility table is forbidden until the future additive memex_grants overlay,
    // which this Spec does NOT build. Assert none of those table names exist.
    const tables = (await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    )) as unknown as Array<{ table_name: string }>;
    const names = new Set(tables.map((t) => t.table_name));
    for (const forbidden of ["memex_grants", "doc_visibility", "doc_access", "spec_visibility", "doc_acl"]) {
      expect(names.has(forbidden), `spec-118 must not introduce a visibility table (${forbidden})`).toBe(false);
    }
    // The org-level access table is still the gate, and doc_members is purely a
    // capability layer that sits above it (no access columns).
    expect(names.has("org_memberships"), "org-level access gate must remain").toBe(true);
    expect(names.has("doc_members"), "doc_members capability table must exist").toBe(true);
    const memberCols = (await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'doc_members'`,
    )) as unknown as Array<{ column_name: string }>;
    const colNames = new Set(memberCols.map((c) => c.column_name));
    // No access/visibility flavoured column — role is capability, not access.
    for (const accessCol of ["can_read", "visibility", "access_level", "is_private"]) {
      expect(colNames.has(accessCol), `doc_members must carry no access column (${accessCol})`).toBe(false);
    }
  });
});
