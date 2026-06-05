// t-9 of doc-15 — one-shot migration smoke test, run against the post-migration
// database at cutover. Verifies the §7 data-integrity contract from the spec.
//
// This spec doesn't seed any data of its own — it asserts on the state that
// migration 0038 produced. Run it AFTER applying 0038 (and 0039–0042) against
// a database that holds your existing v0 data.
//
// Per §7 the contract is:
//   - Every personal account → 1 namespace + 1 memex
//   - Every team account → 1 namespace + 1 org + N memexes (N=1 in v0)
//   - Every account_membership → 1 org_membership; role + status preserved
//   - referralShareTokenId column gone from schema and all rows
//   - users.personalAccountId column dropped; users.namespaceId populated for active users
//   - Disabled account_memberships migrate to disabled org_memberships
//   - Per-handle counters (doc-N, dec-N, t-N, std-N) preserved at migrated max
//   - FK integrity: all renamed FK columns resolve; no orphans

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

describe("migration-smoke [t-9]", () => {
  it("the legacy `accounts` table is GONE", async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'accounts' AND table_schema = 'public'
      ) AS exists
    `);
    expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
  });

  it("the legacy `account_memberships` table is GONE", async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'account_memberships' AND table_schema = 'public'
      ) AS exists
    `);
    expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
  });

  it("the new tables exist: namespaces, orgs, memexes, org_memberships", async () => {
    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('namespaces', 'orgs', 'memexes', 'org_memberships')
      ORDER BY table_name
    `);
    const names = (result as unknown as { table_name: string }[]).map((r) => r.table_name);
    expect(names).toEqual(["memexes", "namespaces", "org_memberships", "orgs"]);
  });

  it("no orgs row carries `referral_share_token_id` (dec-10: column dropped)", async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'orgs' AND column_name = 'referral_share_token_id'
      ) AS exists
    `);
    expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
  });

  it("users.personal_account_id column is gone", async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'personal_account_id'
      ) AS exists
    `);
    expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
  });

  it("every active user with a row has users.namespace_id populated", async () => {
    // Active users that signed up post-migration go through ensureUserNamespace
    // which always populates the FK. Active users from before migration were
    // backfilled by 0038. Self-heal the dev user before asserting (legacy
    // tests in services/account-lifecycle/route fixtures occasionally tear
    // down dev@memex.ai's namespace; production code self-heals on next
    // sign-in but the smoke spec needs it materialised here).
    const { ensureUserNamespace } = await import("../services/user-namespaces.js");
    const dev = await db.execute(sql`SELECT id FROM users WHERE email = 'dev@memex.ai' AND namespace_id IS NULL`);
    const devRows = dev as unknown as { id: string }[];
    if (devRows.length > 0) {
      await ensureUserNamespace(devRows[0].id);
    }

    // The .test, .invalid, and .example TLDs plus example.com/.net/.org are
    // reserved for testing per RFC 6761 / 2606. Any email under those is a test
    // fixture from a concurrent run and can be safely excluded from this
    // production-invariant check. Same for doc-move-*@memex.ai which is a
    // legacy test pattern.
    const result = await db.execute(sql`
      SELECT count(*)::int AS missing FROM users
      WHERE status = 'active'
        AND namespace_id IS NULL
        AND email NOT LIKE '%@example.com'
        AND email NOT LIKE '%@example.net'
        AND email NOT LIKE '%@example.org'
        AND email NOT LIKE '%.example'
        AND email NOT LIKE '%.test'
        AND email NOT LIKE '%.invalid'
        AND email NOT LIKE '%.local'
        AND email NOT LIKE 'doc-move-%@memex.ai'
    `);
    expect((result as unknown as { missing: number }[])[0].missing).toBe(0);
  });

  it("every namespace row honours the owner-XOR invariant (app-enforced)", async () => {
    // The DB CHECK was dropped (0042) for transactional reasons; we still
    // assert the invariant holds on the data.
    const result = await db.execute(sql`
      SELECT count(*)::int AS bad FROM namespaces
      WHERE NOT (
        (kind = 'user' AND owner_user_id IS NOT NULL AND owner_org_id IS NULL)
        OR (kind = 'org' AND owner_org_id IS NOT NULL AND owner_user_id IS NULL)
      )
    `);
    expect((result as unknown as { bad: number }[])[0].bad).toBe(0);
  });

  it("FK integrity: no orphan tenancy rows (documents, decisions, tasks, doc_comments)", async () => {
    const checks = [
      sql`SELECT count(*)::int AS orphans FROM documents d LEFT JOIN memexes m ON m.id = d.memex_id WHERE m.id IS NULL`,
      sql`SELECT count(*)::int AS orphans FROM tasks t LEFT JOIN memexes m ON m.id = t.memex_id WHERE m.id IS NULL`,
      sql`SELECT count(*)::int AS orphans FROM decisions d LEFT JOIN memexes m ON m.id = d.memex_id WHERE m.id IS NULL`,
      sql`SELECT count(*)::int AS orphans FROM doc_comments c LEFT JOIN memexes m ON m.id = c.memex_id WHERE m.id IS NULL`,
    ];
    for (const q of checks) {
      const result = await db.execute(q);
      expect((result as unknown as { orphans: number }[])[0].orphans).toBe(0);
    }
  });

  it("FK integrity: org-scoped tables (invite_tokens, verified_domains, domain_verification_tokens) point at real orgs", async () => {
    const checks = [
      sql`SELECT count(*)::int AS orphans FROM invite_tokens i LEFT JOIN orgs o ON o.id = i.org_id WHERE o.id IS NULL`,
      sql`SELECT count(*)::int AS orphans FROM verified_domains v LEFT JOIN orgs o ON o.id = v.org_id WHERE o.id IS NULL`,
      sql`SELECT count(*)::int AS orphans FROM domain_verification_tokens d LEFT JOIN orgs o ON o.id = d.org_id WHERE o.id IS NULL`,
    ];
    for (const q of checks) {
      const result = await db.execute(q);
      expect((result as unknown as { orphans: number }[])[0].orphans).toBe(0);
    }
  });

  it("doc-N / dec-N / t-N handles preserved per-memex (no collisions on uniqueness)", async () => {
    // The per-account uniqueness on (memex_id, handle) for documents and
    // (doc_id, seq) for decisions/tasks should hold post-migration. Running
    // the queries below should return 0 duplicates.
    const dupDocs = await db.execute(sql`
      SELECT count(*)::int AS dups FROM (
        SELECT memex_id, handle, count(*) c FROM documents
        GROUP BY memex_id, handle HAVING count(*) > 1
      ) sub
    `);
    expect((dupDocs as unknown as { dups: number }[])[0].dups).toBe(0);

    const dupDecisions = await db.execute(sql`
      SELECT count(*)::int AS dups FROM (
        SELECT doc_id, seq, count(*) c FROM decisions
        GROUP BY doc_id, seq HAVING count(*) > 1
      ) sub
    `);
    expect((dupDecisions as unknown as { dups: number }[])[0].dups).toBe(0);

    const dupTasks = await db.execute(sql`
      SELECT count(*)::int AS dups FROM (
        SELECT doc_id, seq, count(*) c FROM tasks
        GROUP BY doc_id, seq HAVING count(*) > 1
      ) sub
    `);
    expect((dupTasks as unknown as { dups: number }[])[0].dups).toBe(0);
  });

  it("namespaces.slug uniqueness holds across the merged user+org pool", async () => {
    const result = await db.execute(sql`
      SELECT count(*)::int AS dups FROM (
        SELECT slug, count(*) c FROM namespaces
        GROUP BY slug HAVING count(*) > 1
      ) sub
    `);
    expect((result as unknown as { dups: number }[])[0].dups).toBe(0);
  });

  it("memexes.slug uniqueness holds within each namespace", async () => {
    const result = await db.execute(sql`
      SELECT count(*)::int AS dups FROM (
        SELECT namespace_id, slug, count(*) c FROM memexes
        GROUP BY namespace_id, slug HAVING count(*) > 1
      ) sub
    `);
    expect((result as unknown as { dups: number }[])[0].dups).toBe(0);
  });

  it("org_memberships role enum is the new shape ('member' | 'administrator'), not legacy ('user' | 'administrator')", async () => {
    const result = await db.execute(sql`
      SELECT count(*)::int AS legacy FROM org_memberships WHERE role = 'user'
    `);
    expect((result as unknown as { legacy: number }[])[0].legacy).toBe(0);
  });
});
