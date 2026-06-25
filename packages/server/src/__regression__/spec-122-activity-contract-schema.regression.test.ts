// spec-122 t-1 (dec-2 / dec-4 / dec-5) — schema guarantees for the activity
// contract columns and the presence plane introduced by migration
// 0087_add_activity_contract_and_presence.
//
// Runs against the local dev DB (like the other __regression__ specs). The
// global-setup runs `pnpm db:migrate` (journal + hand migrations) against the
// test DB before cloning per-worker, so 0085 is applied here automatically.
//
//   ac-9  every activity-bearing source table exposes the contract columns
//         (WHEN via its own timestamp, WHO via actor_user_id + actor_name, HOW
//         via channel, WHAT-coarse via its owning-spec FK) — the uniform shape the
//         activity view (t-6) projects across every arm.
//
// Also asserts the structural commitments T1 owns that other tasks build ON:
//   - the presence plane exists with the dec-4 shape (decay key + vocabularies)
//   - NO phase_transitions table (dec-3) and NO user_identities table (dec-8)
//
// TAGGED with tagAc → reports to the PROD memex (the spec lives at mindset-prod/…).
// A human runs this with MEMEX_EMIT_KEY set; auto mode skips tagged suites.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

async function columnNames(table: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table}
  `);
  return (rows as unknown as { column_name: string }[]).map((r) => r.column_name);
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
  `);
  return (rows as unknown as unknown[]).length === 1;
}

async function checkClause(constraint: string): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = ${constraint}
  `);
  const r = (rows as unknown as { def: string }[])[0];
  return r ? r.def : null;
}

describe("regression: activity contract + presence schema [spec-122 t-1]", () => {
  // The four source tables that lacked WHO/HOW and gain the full contract.
  const NEEDED_FULL = ["acs", "tasks", "decisions", "doc_sections"] as const;

  // ── ac-9 ──────────────────────────────────────────────────────────────────
  it("ac-9: acs / tasks / decisions / doc_sections expose actor_user_id + actor_name + channel", async () => {
    tagAc(`${AC}/ac-9`);
    for (const table of NEEDED_FULL) {
      const cols = await columnNames(table);
      expect(cols, `${table}.actor_user_id`).toContain("actor_user_id");
      expect(cols, `${table}.actor_name`).toContain("actor_name");
      expect(cols, `${table}.channel`).toContain("channel");
    }
  });

  it("ac-9: doc_comments completes the contract with channel (WHO already present)", async () => {
    tagAc(`${AC}/ac-9`);
    const cols = await columnNames("doc_comments");
    expect(cols).toContain("channel");
    // WHO was already there — the contract is now whole on this arm.
    expect(cols).toContain("author_user_id");
    expect(cols).toContain("author_name");
  });

  it("ac-9: every activity-bearing source table also carries its own WHEN + a spec_ref join key", async () => {
    tagAc(`${AC}/ac-9`);
    // WHEN comes from each row's own timestamp (provenance, ac-8); spec_ref is
    // the owning-spec FK (acs.brief_id et al). These pre-exist; the test pins the
    // non-actor fields are genuinely satisfiable per arm.
    const briefArm = await columnNames("acs");
    expect(briefArm).toContain("created_at");
    expect(briefArm).toContain("brief_id");

    for (const table of ["tasks", "decisions"] as const) {
      const cols = await columnNames(table);
      expect(cols).toContain("created_at");
      expect(cols).toContain("doc_id");
    }
  });

  it("ac-9: the channel column is constrained to the contract's four surfaces (NULL allowed)", async () => {
    tagAc(`${AC}/ac-9`);
    for (const table of [...NEEDED_FULL, "doc_comments"]) {
      const def = await checkClause(`${table}_channel_valid`);
      expect(def, `${table}_channel_valid missing`).not.toBeNull();
      expect(def).toContain("rest_ui");
      expect(def).toContain("mcp");
      expect(def).toContain("in_app_agent");
      expect(def).toContain("server");
    }
  });

  // ── presence plane (dec-4 structural precondition for t-7) ──────────────────
  it("presence table exists with the decay key + denormalised actor + vocabularies", async () => {
    expect(await tableExists("presence")).toBe(true);
    const cols = await columnNames("presence");
    for (const c of [
      "memex_id",
      "doc_id",
      "actor_user_id",
      "actor_name",
      "actor_kind",
      "channel",
      "client_id",
      "last_seen_at",
    ]) {
      expect(cols, `presence.${c}`).toContain(c);
    }

    // The upsert conflict target — one row per (doc, actor, channel, client).
    const uniqueDef = await checkClause("presence_doc_actor_channel_client_unique");
    expect(uniqueDef).toContain("doc_id");
    expect(uniqueDef).toContain("actor_user_id");
    expect(uniqueDef).toContain("channel");
    expect(uniqueDef).toContain("client_id");
  });

  // ── no parallel ledgers (dec-3 / dec-8 structural half) ─────────────────────
  it("no phase_transitions table (dec-3 — phase history rides spec-179 status_changed rows)", async () => {
    expect(await tableExists("phase_transitions")).toBe(false);
  });

  it("no user_identities table (dec-8 — the WHO resolver reuses existing columns)", async () => {
    expect(await tableExists("user_identities")).toBe(false);
  });
});
