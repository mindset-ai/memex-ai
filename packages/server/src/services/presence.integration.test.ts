// spec-122 t-7 (dec-4) — the ephemeral PRESENCE plane.
//
//   ac-15  a "dark" agent session (mcp telemetry, NO presence row) still
//          appears present — the passive-telemetry floor.
//   ac-16  the browser heartbeat upserts a single presence row, bumps its
//          last_seen_at on each beat, and a row past the TTL decays (excluded).
//   ac-17  a presence write is SILENT — it produces NO "what's moving" activity
//          line on the change bus (presence is out-of-band per std-8).
//
// TAGGED with tagAc → reports to the PROD memex. Runs with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  presence,
  mcpSessions,
  mcpToolCalls,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { markPresent, listPresent, PRESENCE_TTL_MS } from "./presence.js";
import { bus, type ChangeEvent } from "./bus.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  sessions: [] as string[],
};

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `s122p-${sub}@memex.ai`, name: "Christine" } as typeof users.$inferInsert)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
let specDocId: string;
let specHandle: string;

beforeAll(async () => {
  actor = await setupActor("presence");
  const doc = await createDocDraft(actor.memexId, "Pulse spec", "P", "spec");
  specDocId = doc.id;
  specHandle = doc.handle;
  created.docs.push(specDocId);
});

afterAll(async () => {
  await db.delete(presence).where(inArray(presence.docId, created.docs)).catch(() => {});
  if (created.sessions.length)
    await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, created.sessions)).catch(() => {});
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("presence plane [spec-122 t-7]", () => {
  // ── ac-15 ───────────────────────────────────────────────────────────────
  it("ac-15: a dark agent session (mcp telemetry, no presence row) appears present via the floor", async () => {
    tagAc(`${AC}/ac-15`);
    const sessionId = `sess-${Math.random().toString(36).slice(2, 10)}`;
    created.sessions.push(sessionId);

    // A recent session, with a recent tool_call whose argsJson.ref points at the
    // seeded spec — and NO presence-table row for it.
    await db.insert(mcpSessions).values({
      sessionId,
      userId: actor.user.id,
      clientName: "Claude Code",
      lastSeenAt: new Date(),
    });
    const ref = `${actor.nsSlug}/main/specs/${specHandle}`;
    await db.insert(mcpToolCalls).values({
      sessionId,
      userId: actor.user.id,
      memexId: actor.memexId,
      toolName: "get_doc",
      argsJson: { ref },
      durationMs: 5,
      createdAt: new Date(),
    } as typeof mcpToolCalls.$inferInsert);

    // No presence row seeded — assert the floor still surfaces the dark agent.
    const rows = await listPresent(actor.memexId, specDocId);
    const floor = rows.find((r) => r.clientId === sessionId);
    expect(floor, "the dark agent must appear present").toBeDefined();
    expect(floor?.actorKind).toBe("mcp_agent");
    expect(floor?.channel).toBe("mcp");
    expect(floor?.actorUserId).toBe(actor.user.id);
    // Labelled "Christine's Claude Code" via resolveAgentClientLabel.
    expect(floor?.actorName).toContain("Claude Code");
  });

  // ── ac-16 ───────────────────────────────────────────────────────────────
  it("ac-16: the heartbeat upserts one row (channel=rest_ui), bumps it, and decays past TTL", async () => {
    tagAc(`${AC}/ac-16`);

    // First beat — a human declares presence on the spec.
    await markPresent({
      memexId: actor.memexId,
      docId: specDocId,
      actorUserId: actor.user.id,
      actorName: "Christine",
      actorKind: "human",
      channel: "rest_ui",
      clientId: "tab-1",
    });

    const after1 = await db
      .select()
      .from(presence)
      .where(
        and(
          eq(presence.docId, specDocId),
          eq(presence.actorUserId, actor.user.id),
          eq(presence.channel, "rest_ui"),
          eq(presence.clientId, "tab-1"),
        ),
      );
    expect(after1).toHaveLength(1);
    const firstSeen = after1[0].lastSeenAt;
    expect(Date.now() - firstSeen.getTime()).toBeLessThan(PRESENCE_TTL_MS);

    // It's within the TTL → present.
    const present1 = await listPresent(actor.memexId, specDocId);
    expect(present1.some((r) => r.clientId === "tab-1" && r.channel === "rest_ui")).toBe(true);

    // Second beat — SAME row (upsert, not duplicate), last_seen_at bumped.
    await new Promise((res) => setTimeout(res, 15));
    await markPresent({
      memexId: actor.memexId,
      docId: specDocId,
      actorUserId: actor.user.id,
      actorName: "Christine",
      actorKind: "human",
      channel: "rest_ui",
      clientId: "tab-1",
    });
    const after2 = await db
      .select()
      .from(presence)
      .where(
        and(
          eq(presence.docId, specDocId),
          eq(presence.actorUserId, actor.user.id),
          eq(presence.channel, "rest_ui"),
          eq(presence.clientId, "tab-1"),
        ),
      );
    expect(after2, "upsert must not create a duplicate row").toHaveLength(1);
    expect(after2[0].lastSeenAt.getTime()).toBeGreaterThan(firstSeen.getTime());

    // Decay: a row older than the TTL is excluded from listPresent.
    await db
      .update(presence)
      .set({ lastSeenAt: new Date(Date.now() - PRESENCE_TTL_MS - 5_000) })
      .where(
        and(
          eq(presence.docId, specDocId),
          eq(presence.actorUserId, actor.user.id),
          eq(presence.channel, "rest_ui"),
          eq(presence.clientId, "tab-1"),
        ),
      );
    const present2 = await listPresent(actor.memexId, specDocId);
    expect(
      present2.some((r) => r.clientId === "tab-1" && r.channel === "rest_ui"),
      "a row past the TTL must decay out of listPresent",
    ).toBe(false);
  });

  // ── ac-17 ───────────────────────────────────────────────────────────────
  it("ac-17: a presence write emits NO mutation activity on the change bus (silent)", async () => {
    tagAc(`${AC}/ac-17`);
    const seen: ChangeEvent[] = [];
    const unsub = bus.subscribe({ memexId: actor.memexId }, (e) => seen.push(e));
    try {
      await markPresent({
        memexId: actor.memexId,
        docId: specDocId,
        actorUserId: actor.user.id,
        actorName: "Christine",
        actorKind: "human",
        channel: "rest_ui",
        clientId: "tab-silent",
      });
    } finally {
      unsub();
    }
    // No "what's moving" activity line for a heartbeat — no created/updated/deleted.
    const mutations = seen.filter(
      (e) => e.action === "created" || e.action === "updated" || e.action === "deleted",
    );
    expect(mutations, "presence is silent — no mutation event").toHaveLength(0);
  });
});
