// spec-396 — SECURITY regression: the activity_view test_events arm must NOT
// leak one memex's test activity into another memex that shares a spec handle.
//
// THE BUG (migration 0089): the test_events arm joined test_events → documents on
// the spec HANDLE alone. test_events has no memex_id and no RLS, and spec handles
// ("spec-1", "spec-99", …) collide across every memex, so one memex's test event
// matched every other memex's same-numbered spec and surfaced — actor name, status,
// timing — in the foreign memex's get_doc agent footer / Pulse / Home feeds. On
// prod, markhadfield@agent-craft bled into mindset-prod/memex-building-itself
// (~1.5M rows). FIX (migration 0109): scope the arm by the FULL ac_uid prefix
// (<namespace>/<memex>) so a test event can only attach to a spec in its OWN memex.
//
// This test reproduces the colliding-handle scenario and FAILS if the bleed
// returns (ac-1, ac-2). It also proves legitimate same-memex events still surface
// (ac-3). Tagged so verification lands on spec-396.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  testEvents,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { listActivityView } from "../services/activity-view.js";
import { craftActivityBlock } from "./tool-specs.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-396/acs";

const created = {
  users: [] as string[],
  namespaces: [] as string[],
  orgs: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  testEvents: [] as string[],
};

// Two SEPARATE tenants (namespace + org + memex each). Both memexes are slugged
// "main"; the leak is on the SPEC handle, which collides across memexes.
let nsAslug: string;
let memexAId: string;
let docAId: string;
let handleA: string;

let memexBId: string;
let docBId: string;
let handleB: string;

let callerId: string; // a member of tenant B, the one reading B's footer
let foreignActor: string; // the free-form CI actor on tenant A's event

async function makeTenant(tag: string): Promise<{ nsSlug: string; memexId: string }> {
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: `s396-${tag}`, kind: "org" })
    .returning();
  created.namespaces.push(ns.id);
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  created.orgs.push(org.id);
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` })
    .returning();
  created.memexes.push(m.id);
  return { nsSlug: ns.slug, memexId: m.id };
}

async function makeSpec(memexId: string, title: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, "x", "spec");
  created.docs.push(doc.id);
  const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
  return { id: doc.id, handle: row.handle };
}

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  foreignActor = `craftspy-${tag}`;

  const [caller] = await db
    .insert(users)
    .values({ email: `caller-${tag}@memex.ai`, name: `Caller ${tag}` } as typeof users.$inferInsert)
    .returning();
  callerId = caller.id;
  created.users.push(caller.id);

  // Tenant A — owns the test event that must NOT leak.
  const a = await makeTenant(`${tag}a`);
  nsAslug = a.nsSlug;
  memexAId = a.memexId;
  const sa = await makeSpec(memexAId, "Tenant A spec");
  docAId = sa.id;
  handleA = sa.handle;

  // Tenant B — the victim memex doing the reading.
  const b = await makeTenant(`${tag}b`);
  memexBId = b.memexId;
  // Make B's org include the caller so craftActivityBlock renders for them.
  const [orgB] = await db
    .select()
    .from(orgs)
    .where(eq(orgs.id, created.orgs[created.orgs.length - 1]));
  await db.insert(orgMemberships).values({ userId: caller.id, orgId: orgB.id, role: "administrator" });
  const sb = await makeSpec(memexBId, "Tenant B spec");
  docBId = sb.id;
  handleB = sb.handle;

  // Tenant A emits a CI flip on ITS spec, addressed by A's full canonical ac_uid.
  const subjectRef = `${nsAslug}/main/specs/${handleA}/acs/ac-1`;
  const [te] = await db
    .insert(testEvents)
    .values({
      subjectRef,
      // spec-398: tenancy is now the stored column. memexAId is tenant A; the
      // colliding handle can no longer bridge into tenant B because the arm
      // filters te.memex_id, not a handle-only join.
      memexId: memexAId,
      status: "pass",
      actor: foreignActor,
    } as typeof testEvents.$inferInsert)
    .returning();
  created.testEvents.push(te.id);
});

afterAll(async () => {
  if (created.testEvents.length)
    await db.delete(testEvents).where(inArray(testEvents.id, created.testEvents)).catch(() => {});
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.orgs.length)
    await db.delete(orgs).where(inArray(orgs.id, created.orgs)).catch(() => {});
  if (created.namespaces.length)
    await db.delete(namespaces).where(inArray(namespaces.id, created.namespaces)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("activity_view is tenant-isolated across colliding spec handles [spec-396]", () => {
  it("precondition: both tenants' first spec share the same handle (the collision)", () => {
    // If this ever fails, handles stopped colliding and the test no longer
    // exercises the bug — fix the fixture, don't delete the guard.
    expect(handleA).toBe(handleB);
  });

  it("ac-1: tenant B's activity view never returns tenant A's test event", async () => {
    tagAc(`${AC}/ac-1`);
    const rows = await listActivityView(memexBId, { specRef: docBId });
    const leaked = rows.filter((r) => r.actorRaw === foreignActor);
    expect(leaked, "no foreign test_event may appear in another memex's activity").toEqual([]);
  });

  it("ac-2: tenant B's get_doc footer never names tenant A's CI actor", async () => {
    tagAc(`${AC}/ac-2`);
    const block = await craftActivityBlock(memexBId, docBId, callerId);
    expect(block ?? "").not.toContain(foreignActor);
  });

  it("ac-3: the event STILL appears in its own memex's activity (no over-scoping)", async () => {
    tagAc(`${AC}/ac-3`);
    const rows = await listActivityView(memexAId, { specRef: docAId });
    const own = rows.filter((r) => r.actorRaw === foreignActor);
    expect(own.length, "the legitimate same-memex event must be preserved").toBeGreaterThan(0);
  });
});
