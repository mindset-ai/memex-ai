// spec-122 t-8 (dec-7) — the get_doc ACTIVITY/collision block.
//
//   ac-23  the get_doc response for a spec includes an ACTIVITY/presence block
//          (recent material change + who + live-session presence) delivered via
//          spec-203's decideFooter seat, with NO new MCP tool added.
//   ac-24  when another session is materially advancing the spec (AC delta /
//          phase move / task churn by a DIFFERENT actor recently), the block
//          surfaces an ADVISORY line; the call still returns normally and is
//          never blocked or auto-aborted.
//
// TAGGED → reports to the PROD memex. Run with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, namespaces, orgs, orgMemberships, memexes, documents, acs, activityLog } from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createAc } from "../services/acs.js";
import { markPresent } from "../services/presence.js";
import { createMcpServer } from "../mcp/tools.js";
import { craftActivityBlock, composeGuidanceEnvelope, type ToolCtx } from "./tool-specs.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
let memexId: string;
let userA: string; // the caller
let userB: string; // the OTHER session advancing the spec
let docId: string;

function ctxFor(userId: string): ToolCtx {
  // Minimal ctx for the terse footer path (verbose:false). Cast — the terse path
  // only reads verbose + userId; craftActivityBlock reads userId.
  return {
    userId,
    verbose: false,
    channel: "mcp",
    toolName: "get_doc",
    workspaceUrl: async () => "",
  } as unknown as ToolCtx;
}

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [a] = await db.insert(users).values({ email: `a-${tag}@memex.ai`, name: "Barrie" } as typeof users.$inferInsert).returning();
  const [b] = await db.insert(users).values({ email: `b-${tag}@memex.ai`, name: "Christine" } as typeof users.$inferInsert).returning();
  userA = a.id; userB = b.id; created.users.push(a.id, b.id);
  const [ns] = await db.insert(namespaces).values({ slug: `gda-${tag}`, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id; created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: a.id, orgId: org.id, role: "administrator" });
  await db.insert(orgMemberships).values({ userId: b.id, orgId: org.id, role: "administrator" });

  const doc = await createDocDraft(memexId, "Activity", "x", "spec");
  docId = doc.id; created.docs.push(doc.id);

  // userB materially advances the spec (an AC delta) AND is present.
  await createAc(
    { memexId, briefId: docId, kind: "scope", statement: "B's AC" },
    { actorUserId: userB, actorName: "Christine", channel: "mcp" },
  );
  await markPresent({ memexId, docId, actorUserId: userB, actorName: "Christine", actorKind: "mcp_agent", channel: "mcp", clientId: "sess-b" });
});

afterAll(async () => {
  if (created.memexes.length) {
    // The b-36 test inserts an activity_log row directly; clear it before the
    // memex delete so its FK doesn't block teardown.
    await db.delete(activityLog).where(inArray(activityLog.memexId, created.memexes)).catch(() => {});
  }
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("get_doc ACTIVITY block [spec-122 t-8]", () => {
  // ── ac-23 ───────────────────────────────────────────────────────────────
  it("ac-23: the block carries recent material change + who + live presence", async () => {
    tagAc(`${AC}/ac-23`);
    const block = await craftActivityBlock(memexId, docId, userA);
    expect(block).toBeTruthy();
    expect(block!).toContain("ACTIVITY");
    expect(block!).toContain("recent:");
    expect(block!).toContain("present now:");
    expect(block!).toContain("Christine"); // the other actor / present session
  });

  it("ac-23: it rides the decideFooter seat (the get_doc footer), and adds NO new MCP tool", async () => {
    tagAc(`${AC}/ac-23`);
    // spec-219 renamed the single footer seat to composeGuidanceEnvelope, which
    // returns a {header?, footer?} envelope; the ACTIVITY block rides the footer.
    const env = await composeGuidanceEnvelope(memexId, docId, ctxFor(userA));
    const footer = env.footer;
    expect(footer, "composeGuidanceEnvelope returns a footer for the spec").toBeTruthy();
    expect(footer!).toContain("ACTIVITY");

    // No new MCP tool was added for presence/activity — it rides get_doc.
    const server = createMcpServer(userA);
    const toolNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    for (const forbidden of ["get_spec_presence", "get_presence", "get_activity", "spec_presence"]) {
      expect(toolNames).not.toContain(forbidden);
    }
  });

  // ── ac-24 ───────────────────────────────────────────────────────────────
  it("ac-24: a DIFFERENT actor advancing recently surfaces an advisory line", async () => {
    tagAc(`${AC}/ac-24`);
    const block = await craftActivityBlock(memexId, docId, userA);
    expect(block!).toContain("⚠");
    expect(block!.toLowerCase()).toContain("advancing this spec");
    expect(block!.toLowerCase()).toContain("advisory");
  });

  it("ac-24: the caller's OWN work raises no advisory (no false alarm on yourself)", async () => {
    tagAc(`${AC}/ac-24`);
    // From userB's vantage (B did the work), there's no OTHER actor advancing it.
    const block = await craftActivityBlock(memexId, docId, userB);
    // recent line may still show B's own change, but never the collision warning.
    expect(block === null || !block.includes("⚠")).toBe(true);
  });

  // b-36 hard cut (authed.smoke.test.ts): get_doc must never emit a raw UUID.
  // The footer replays IMMUTABLE activity_log narratives, so a row written before
  // the spec-122 narrative fix can still read "created doc_member <uuid>" — the
  // footer must strip it rather than leak it. Guards against the int smoke red.
  it("b-36: a historical activity_log narrative carrying a raw UUID is stripped from the footer", async () => {
    tagAc(`${AC}/ac-23`);
    const leakedId = "322dda5d-b14c-4597-b106-c13b847905ac";
    await db.insert(activityLog).values({
      memexId,
      briefId: docId,
      actorKind: "system",
      channel: "server",
      entity: "doc_member",
      action: "created",
      narrative: `created doc_member ${leakedId}`,
    });
    const block = await craftActivityBlock(memexId, docId, userA);
    expect(block).toBeTruthy();
    expect(
      block!,
      "the ACTIVITY footer must never emit a raw UUID (b-36 no-UUIDs-out)",
    ).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // The readable remainder survives the strip — only the UUID token is removed.
    expect(block!).toContain("doc_member");
  });

  it("ac-24: the call returns normally — advisory only, never blocks or throws", async () => {
    tagAc(`${AC}/ac-24`);
    // decideFooter is best-effort: it returns a string/null, never throws, never
    // aborts the underlying tool call.
    await expect(composeGuidanceEnvelope(memexId, docId, ctxFor(userA))).resolves.toBeDefined();
    // A bogus docId must degrade to null, not throw.
    await expect(
      craftActivityBlock(memexId, "00000000-0000-0000-0000-000000000000", userA),
    ).resolves.toBeNull();
  });
});
