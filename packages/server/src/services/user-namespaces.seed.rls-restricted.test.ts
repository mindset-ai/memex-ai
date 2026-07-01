// spec-440 — the RESTRICTED-ROLE regression (runs ONLY under vitest.rls.config.ts,
// i.e. connected AS the non-owner `memex_app` role, RLS-subject). This is the test
// the spec-436 fix could not have here in the owner-connection suite: because the
// default suite connects as the DB owner (RLS bypassed), a "did the docs seed?"
// assertion passes with OR without the runWithMemexId wrapper. Under memex_app it
// does not — a context-less write to a gated table is REJECTED by Postgres, so the
// spec-436 empty-workspace class is finally catchable by OUTCOME, in CI, on a laptop.
//
// This file is excluded from the default project (vitest.config.ts) and included
// only by vitest.rls.config.ts. `make test-rls` runs it. It exercises real service
// code (ensureUserNamespace → seedNewPersonalMemex) through the singleton, so the
// connecting role — not a hand-rolled second connection — is what enforces RLS.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import { documents, namespaces, standardClauses, users } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { backfillDefaultStandards } from "./default-standards.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-440/acs";

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];

async function makeUserWithMemex(tag: string): Promise<{ userId: string; memexId: string }> {
  const user = await upsertUserByEmail(
    `spec440-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  );
  createdUserIds.push(user.id);
  const created = await ensureUserNamespace(user.id);
  createdMemexIds.push(created.memex.id);
  const [ns] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(and(eq(namespaces.ownerUserId, user.id), eq(namespaces.kind, "user")))
    .limit(1);
  if (ns) createdNamespaceIds.push(ns.id);
  return { userId: user.id, memexId: created.memex.id };
}

let fixtureMemexId: string;

beforeAll(async () => {
  // A memex to hang the deliberate-rejection test on. Seeds are off suite-wide,
  // so this creates only non-gated rows (namespace + memex) — writable by
  // memex_app without a tenant GUC.
  const fixture = await makeUserWithMemex("fixture");
  fixtureMemexId = fixture.memexId;
});

afterAll(async () => {
  // Clean up as memex_app WITH the tenant GUC set, so gated deletes satisfy RLS.
  // Best-effort — the per-worker clone is dropped/recreated every run anyway.
  for (const memexId of createdMemexIds) {
    await runWithMemexId(memexId, async () => {
      await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
    });
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("spec-440 — provisioning seed under the restricted memex_app role", () => {
  it("ac-6: the singleton is connected AS the non-owner memex_app role", async () => {
    tagAc(`${AC}/ac-6`);

    const rows = (await db.execute(
      sql`SELECT current_user AS role, (rolbypassrls OR rolsuper) AS bypasses
          FROM pg_roles WHERE rolname = current_user`,
    )) as unknown as Array<{ role: string; bypasses: boolean }>;

    // The whole point of the harness: real service code runs as an RLS-subject
    // role, not the owner. If this ever reads `postgres`, the project mis-wired
    // and every RLS assertion below would be vacuous.
    expect(rows[0]?.role).toBe("memex_app");
    expect(rows[0]?.bypasses).toBe(false);
  });

  it("ac-1/ac-2: a context-less write to a gated table is REJECTED by RLS and made LOUD", async () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-2`);

    const { __clearRlsGuardWarnedTablesForTests } = await import("../db/rls-context-guard.js");
    __clearRlsGuardWarnedTablesForTests();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {}); // silence the domain log fan-out

    try {
      // No runWithMemexId → no app.memex_id. Under memex_app the documents
      // WITH CHECK policy rejects this INSERT — the exact spec-436 failure.
      let caught: unknown;
      try {
        await db.insert(documents).values({
          memexId: fixtureMemexId,
          handle: "spec440-rls-reject",
          title: "should be rejected",
          docType: "document",
        });
      } catch (err) {
        caught = err;
      }

      // Drizzle wraps the driver error ("Failed query: …"); the Postgres RLS
      // message rides on `.cause`. Check both so we assert the REAL cause, not
      // merely that some error was thrown.
      expect(caught, "the context-less gated write must be rejected").toBeDefined();
      const errText = `${(caught as Error)?.message ?? ""} ${
        ((caught as Error)?.cause as Error | undefined)?.message ?? ""
      }`;
      expect(errText).toMatch(/row-level security/i);

      // …and the guard made it LOUD before Postgres rejected it (dec-2 phase 1).
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[rls]");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("documents");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ac-7: seedNewPersonalMemex seeds gated rows under memex_app (removing the wrapper would fail this)", async () => {
    tagAc(`${AC}/ac-7`);

    // Turn the default-Standards seeder ON just for this creation (it writes
    // `documents` + `standard_clauses` — both RLS-gated). The gate reads env at
    // call time, so scope it tightly and restore after.
    const prev = process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED;
    process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "on";
    let memexId: string;
    try {
      ({ memexId } = await makeUserWithMemex("seed"));
    } finally {
      process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = prev;
    }

    // Read WITH the tenant GUC (memex_app sees a gated table's rows only under
    // the matching app.memex_id). Non-zero ⇒ the seed INSERTs satisfied RLS,
    // which they can ONLY do because seedNewPersonalMemex wraps them in
    // runWithMemexId(memexId). Remove that wrapper and this drops to 0 → red.
    const { docCount, clauseCount } = await runWithMemexId(memexId, async () => {
      const docs = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.memexId, memexId));
      const clauses = await db
        .select({ id: standardClauses.id })
        .from(standardClauses)
        .where(eq(standardClauses.memexId, memexId));
      return { docCount: docs.length, clauseCount: clauses.length };
    });

    expect(docCount, "default Standards documents should be seeded").toBeGreaterThan(0);
    expect(clauseCount, "default Standards clauses should be seeded").toBeGreaterThan(0);
  });

  it("ac-3: the deploy-wired backfill establishes tenant context under memex_app", async () => {
    tagAc(`${AC}/ac-3`);

    // A fresh personal memex with NO Standards (signup seeds are off suite-wide).
    const { memexId } = await makeUserWithMemex("backfill");
    const before = await runWithMemexId(memexId, async () =>
      (
        await db
          .select({ id: standardClauses.id })
          .from(standardClauses)
          .where(eq(standardClauses.memexId, memexId))
      ).length,
    );
    expect(before, "the fresh memex starts with no Standard clauses").toBe(0);

    // backfillDefaultStandards() loops personal memexes and seeds those with none.
    // Under memex_app its gated INSERTs (documents/standard_clauses/clause_refs)
    // satisfy RLS ONLY because it now wraps each memex in runWithMemexId(memexId)
    // (spec-440). Remove that wrapper and the fresh memex stays empty → red.
    await backfillDefaultStandards();

    const after = await runWithMemexId(memexId, async () =>
      (
        await db
          .select({ id: standardClauses.id })
          .from(standardClauses)
          .where(eq(standardClauses.memexId, memexId))
      ).length,
    );
    expect(after, "backfill should have seeded Standard clauses into the memex").toBeGreaterThan(0);
  });
});
