// spec-474 dec-3 — the one-shot demo→starter sweep, end-to-end against real Postgres.
//
// The sweep (a) deletes every is_demo doc across all personal Memexes and (b) seeds the
// "Understanding Memex" starter Spec into any personal Memex whose owner has NOT authored
// their own real spec — leaving self-authored users and already-starter'd Memexes alone —
// with a --dry-run mode that reports without writing.
//
// Each case builds its OWN personal Memex and scopes the sweep to that memex id
// (opts.onlyMemexIds), so the shared per-worker DB's other fixtures are untouched and the
// assertions are deterministic under parallel execution.
//
// Cleanup deletes each memex's documents then its namespace (cascading memex + user).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, users } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { seedStarterSpec } from "./starter-spec.js";
import { STARTER_SPEC_TITLE } from "../db/starter-spec.fixture.js";
import { sweepDemoToStarter } from "./demo-to-starter-sweep.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-474";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const uniq = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toLowerCase().slice(0, 39);

const createdNamespaceIds: string[] = [];
const createdMemexIds: string[] = [];

// Create a personal Memex (kind='user' namespace, no owning org) with a known owner
// user, returning both ids. Mirrors test-helpers.makePersonalTestMemex but hands back
// the ownerUserId the sweep keys its hasSpec predicate on.
async function makePersonalMemex(prefix: string): Promise<{ memexId: string; ownerUserId: string }> {
  const slug = uniq(prefix);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: `${slug}@example.com` } as typeof users.$inferInsert)
      .returning();
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "user", ownerUserId: user.id })
      .returning();
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Personal" })
      .returning();
    createdNamespaceIds.push(ns.id);
    createdMemexIds.push(memex.id);
    return { memexId: memex.id, ownerUserId: user.id };
  });
}

// Insert a demo (is_demo=true) spec into a memex via the real service.
async function seedDemoSpec(memexId: string, createdByUserId?: string): Promise<void> {
  await createDocDraft(
    memexId,
    "Demo walkthrough",
    "A frozen demo spec.",
    "spec",
    undefined,
    { isDemo: true },
    createdByUserId,
    { channel: "server" },
  );
}

// Count is_demo docs in a memex.
async function countDemoDocs(memexId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  return rows.length;
}

// Count the SYSTEM-attributed starter specs (docType='spec', title=STARTER_SPEC_TITLE,
// createdByUserId IS NULL) — the idempotency marker starter-spec.ts uses.
async function countSystemStarters(memexId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.title, STARTER_SPEC_TITLE),
        isNull(documents.createdByUserId),
      ),
    );
  return rows.length;
}

afterAll(async () => {
  if (createdMemexIds.length > 0) {
    await db.delete(documents).where(inArray(documents.memexId, createdMemexIds)).catch(() => {});
  }
  for (const nsId of createdNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nsId)).catch(() => {});
  }
});

describe("demo→starter sweep (spec-474 dec-3)", () => {
  it("demo docs + owner has no own spec → deletes demos and seeds exactly one starter (ac-15 / ac-16)", async () => {
    tagAc(AC(15));
    tagAc(AC(16));
    const { memexId } = await makePersonalMemex("swa");
    await seedDemoSpec(memexId);
    await seedDemoSpec(memexId);
    expect(await countDemoDocs(memexId)).toBe(2);
    expect(await countSystemStarters(memexId)).toBe(0);

    const res = await sweepDemoToStarter({ dryRun: false, onlyMemexIds: [memexId] });

    // Totals for this scoped run.
    expect(res.demoDocsDeleted).toBe(2);
    expect(res.memexesSeeded).toBe(1);
    expect(res.memexesSkipped).toBe(0);

    // End state: no demo docs, exactly one system starter.
    expect(await countDemoDocs(memexId)).toBe(0);
    expect(await countSystemStarters(memexId)).toBe(1);
  });

  it("owner authored their own real spec → clears demos but seeds NO starter (ac-16)", async () => {
    tagAc(AC(16));
    const { memexId, ownerUserId } = await makePersonalMemex("swb");
    await seedDemoSpec(memexId);
    // The owner's own real (is_demo=false) spec — the skip signal.
    const own = await createDocDraft(
      memexId,
      "My real spec",
      "Authored by the owner.",
      "spec",
      undefined,
      undefined,
      ownerUserId,
      { channel: "server" },
    );

    const res = await sweepDemoToStarter({ dryRun: false, onlyMemexIds: [memexId] });

    expect(res.demoDocsDeleted).toBe(1);
    expect(res.memexesSeeded).toBe(0);
    expect(res.memexesSkipped).toBe(1);
    expect(res.perMemex[0]?.hadOwnSpec).toBe(true);

    // Demos gone, no starter added, owner's spec still present.
    expect(await countDemoDocs(memexId)).toBe(0);
    expect(await countSystemStarters(memexId)).toBe(0);
    const [stillThere] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, own.id), eq(documents.createdByUserId, ownerUserId)));
    expect(stillThere).toBeDefined();
  });

  it("already has a system starter → unchanged, no duplicate (ac-16)", async () => {
    tagAc(AC(16));
    const { memexId } = await makePersonalMemex("swc");
    await seedStarterSpec(memexId, { channel: "server" });
    expect(await countSystemStarters(memexId)).toBe(1);

    const res = await sweepDemoToStarter({ dryRun: false, onlyMemexIds: [memexId] });

    // No new seed (already present) → skipped, and still exactly one starter.
    expect(res.memexesSeeded).toBe(0);
    expect(res.memexesSkipped).toBe(1);
    expect(await countSystemStarters(memexId)).toBe(1);
  });

  it("--dry-run writes nothing; its counts equal the live run that follows; a second live run is a no-op (ac-17)", async () => {
    tagAc(AC(17));
    const { memexId } = await makePersonalMemex("swd");
    await seedDemoSpec(memexId);
    await seedDemoSpec(memexId);

    // DRY-RUN: reports the plan, writes nothing.
    const dry = await sweepDemoToStarter({ dryRun: true, onlyMemexIds: [memexId] });
    expect(dry.demoDocsDeleted).toBe(2);
    expect(dry.memexesSeeded).toBe(1);
    expect(dry.memexesSkipped).toBe(0);
    // Nothing changed on disk.
    expect(await countDemoDocs(memexId)).toBe(2);
    expect(await countSystemStarters(memexId)).toBe(0);

    // LIVE: performs exactly what the dry-run reported.
    const live = await sweepDemoToStarter({ dryRun: false, onlyMemexIds: [memexId] });
    expect(live.demoDocsDeleted).toBe(dry.demoDocsDeleted);
    expect(live.memexesSeeded).toBe(dry.memexesSeeded);
    expect(live.memexesSkipped).toBe(dry.memexesSkipped);
    expect(await countDemoDocs(memexId)).toBe(0);
    expect(await countSystemStarters(memexId)).toBe(1);

    // Idempotent: a second live run deletes 0 / seeds 0.
    const again = await sweepDemoToStarter({ dryRun: false, onlyMemexIds: [memexId] });
    expect(again.demoDocsDeleted).toBe(0);
    expect(again.memexesSeeded).toBe(0);
    expect(again.memexesSkipped).toBe(1);
    expect(await countSystemStarters(memexId)).toBe(1);
  });
});
