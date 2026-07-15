// spec-482 t-3 (ac-11) — the per-user, MCP-driven, monotonic phase high-water
// mark. A DERIVED read over activity_log status_changed rows (no dedicated table).
//
//   ac-11  getPhaseHighWaterMark(userId) returns the furthest phase transition a
//          user has EVER personally completed VIA MCP (channel='mcp'), as one
//          monotonic ordinal per user. Web-UI (rest_ui) moves never advance it;
//          the mark never regresses.
//
// TAGGED → reports to the PROD memex. Run with MEMEX_EMIT_KEY set.

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
  activityLog,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { getPhaseHighWaterMark } from "./phase-watermark.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-482/acs";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
let userId: string; // the subject under test
let otherUserId: string; // a second user, to prove per-user isolation
let memexId: string;
let docId: string;

// Seed one status_changed activity_log row directly — the precise control the
// derived query needs over {actorUserId, channel, payload.to}.
async function seedTransition(
  actorUserId: string,
  channel: "mcp" | "rest_ui",
  to: string,
  from: string,
): Promise<void> {
  await db.insert(activityLog).values({
    memexId,
    briefId: docId,
    actorUserId,
    actorName: "Barrie",
    actorKind: channel === "mcp" ? "mcp_agent" : "human",
    channel,
    entity: "document",
    action: "status_changed",
    narrative: `${from} → ${to}`,
    payload: { from, to },
  } as typeof activityLog.$inferInsert);
}

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `pw-${tag}@memex.ai`, name: "Barrie" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  created.users.push(u.id);
  const [u2] = await db
    .insert(users)
    .values({ email: `pw-other-${tag}@memex.ai`, name: "Other" } as typeof users.$inferInsert)
    .returning();
  otherUserId = u2.id;
  created.users.push(u2.id);

  const [ns] = await db.insert(namespaces).values({ slug: `pw-${tag}`, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id;
  created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });

  const doc = await createDocDraft(memexId, "PW", "x", "spec");
  docId = doc.id;
  created.docs.push(doc.id);
});

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(activityLog).where(inArray(activityLog.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("phase high-water mark: per-user, MCP-driven, monotonic [spec-482 t-3]", () => {
  it("ac-11: 'none' when the user has no MCP-driven transitions", async () => {
    tagAc(`${AC}/ac-11`);
    expect(await getPhaseHighWaterMark(userId)).toBe("none");
  });

  it("ac-11: advances specify_build → build_verify → verify_done as MCP rows land", async () => {
    tagAc(`${AC}/ac-11`);

    await seedTransition(userId, "mcp", "build", "specify");
    expect(await getPhaseHighWaterMark(userId)).toBe("specify_build");

    await seedTransition(userId, "mcp", "verify", "build");
    expect(await getPhaseHighWaterMark(userId)).toBe("build_verify");

    await seedTransition(userId, "mcp", "done", "verify");
    expect(await getPhaseHighWaterMark(userId)).toBe("verify_done");
  });

  it("ac-11: a web-UI (rest_ui) transition does NOT advance the mark", async () => {
    tagAc(`${AC}/ac-11`);
    // otherUser has ONLY a rest_ui build_verify move — the mark stays 'none'.
    await seedTransition(otherUserId, "rest_ui", "verify", "build");
    expect(await getPhaseHighWaterMark(otherUserId)).toBe("none");

    // And an MCP build for the same user advances only to specify_build — the
    // higher-ranked rest_ui move is ignored.
    await seedTransition(otherUserId, "mcp", "build", "specify");
    expect(await getPhaseHighWaterMark(otherUserId)).toBe("specify_build");
  });

  it("ac-11: never regresses — a later, lower-phase MCP row leaves the mark at its max", async () => {
    tagAc(`${AC}/ac-11`);
    // userId already sits at verify_done. A later bounce back to build must NOT
    // pull the monotonic mark down.
    await seedTransition(userId, "mcp", "build", "verify");
    expect(await getPhaseHighWaterMark(userId)).toBe("verify_done");
  });
});
