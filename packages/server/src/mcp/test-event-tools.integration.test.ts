// Integration tests for the ref-keyed test-event MCP tools (spec-127 dec-2):
// get_test_matrix (read), discontinue_test_events + restore_test_events (write).
// Goes through the real createMcpServer registry against Postgres, exercising
// the resolveRefArg → service-layer wiring keyed entirely by canonical AC ref.
//
// Emissions route to the prod Memex (namespace-derived) and need MEMEX_EMIT_KEY
// to land; the assertions verify behaviour, the tags attribute it to the AC.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  acs,
  testEvents,
  testEventLatest,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { createAc } from "../services/acs.js";
import { seedTestEvent } from "../services/test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-127";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  acUids: [] as string[],
};

afterAll(async () => {
  if (created.acUids.length) {
    await db.delete(testEvents).where(inArray(testEvents.acUid, created.acUids)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.acUid, created.acUids)).catch(() => {});
  }
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [u] = await db.insert(users).values({ email: `mcp-te-${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: `Test ${sub}`, slug: "main", namespaceId: ns.id } as any)
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
  return { user: u, nsSlug: ns.slug, memexId: mx.id };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("te");
});

async function seedAcWithRef(
  statement: string,
): Promise<{ acRef: string; specRef: string; uid: string }> {
  const doc = await createDocDraft(actor.memexId, "test-event tools spec", "purpose", "spec");
  created.docs.push(doc.id);
  const ac = await createAc({ memexId: actor.memexId, briefId: doc.id, kind: "scope", statement });
  const specRef = `${actor.nsSlug}/main/specs/${doc.handle}`;
  const acRef = `${specRef}/acs/ac-${ac.seq}`;
  const uid = acRef; // ac_uid IS the canonical ref
  created.acUids.push(uid);
  return { acRef, specRef, uid };
}

describe("ref-keyed test-event MCP tools (spec-127 dec-2)", () => {
  it("registers the three new tools", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(names).toContain("get_test_matrix");
    expect(names).toContain("discontinue_test_events");
    expect(names).toContain("restore_test_events");
  });

  it("get_test_matrix reads the per-identifier digest by AC ref, flagging the pinning identifier [ac-4][ac-5][ac-8]", async () => {
    // ac-4: the matrix read is addressable by the canonical AC ref, composable
    // from the URL the caller holds — no raw-UUID lookup.
    tagAc(`${SPEC}/acs/ac-4`);
    tagAc(`${SPEC}/acs/ac-5`);
    tagAc(`${SPEC}/acs/ac-8`);
    const { acRef, uid } = await seedAcWithRef("matrix read AC");
    await seedTestEvent({ acUid: uid, status: "pass", testIdentifier: "tests/live.test.ts::ok" });
    await seedTestEvent({ acUid: uid, status: "fail", testIdentifier: "tests/orphan.test.ts::renamed" });

    const out = text(await callTool(actor.user.id, "get_test_matrix", { ref: acRef }));
    expect(out).toContain(`ref: ${acRef}`);
    expect(out).toContain("tests/live.test.ts::ok");
    expect(out).toContain("tests/orphan.test.ts::renamed");
    // The failing identifier is flagged as pinning the AC red.
    const orphanLine = out.split("\n").find((l) => l.includes("tests/orphan.test.ts::renamed"))!;
    expect(orphanLine).toContain("PINNING red");
  });

  it("discontinue_test_events soft-hides an orphan by ref and reports the cleared verdict [ac-2][ac-3][ac-4][ac-5]", async () => {
    // ac-4: the discontinue action is addressable by the canonical AC ref.
    // ac-2: retirement is EXPLICIT and actor-driven — the actor (here, the agent
    // calling the tool by ref) retires the orphan; no automatic job does it.
    tagAc(`${SPEC}/acs/ac-2`);
    tagAc(`${SPEC}/acs/ac-3`);
    tagAc(`${SPEC}/acs/ac-4`);
    tagAc(`${SPEC}/acs/ac-5`);
    const { acRef, uid } = await seedAcWithRef("discontinue AC");
    const tid = "tests/gone.test.ts::renamed away";
    await seedTestEvent({ acUid: uid, status: "fail", testIdentifier: tid });

    const out = text(await callTool(actor.user.id, "discontinue_test_events", { ref: acRef, test_identifier: tid }));
    expect(out).toContain(`ref: ${acRef}`);
    expect(out).toContain("retired (soft-hidden) 1 emission");
    // Verdict cleared: the only (failing) identifier is now hidden → untested.
    expect(out).toContain("verification is now: untested");

    // And the matrix now shows it retired.
    const matrix = text(await callTool(actor.user.id, "get_test_matrix", { ref: acRef }));
    const line = matrix.split("\n").find((l) => l.includes(tid))!;
    expect(line).toContain("retired (hidden)");
  });

  it("restore_test_events un-hides by ref and the identifier re-enters the verdict [ac-3]", async () => {
    tagAc(`${SPEC}/acs/ac-3`);
    const { acRef, uid } = await seedAcWithRef("restore AC");
    const tid = "tests/restore.test.ts::it works";
    await seedTestEvent({ acUid: uid, status: "fail", testIdentifier: tid });
    await callTool(actor.user.id, "discontinue_test_events", { ref: acRef, test_identifier: tid });

    const out = text(await callTool(actor.user.id, "restore_test_events", { ref: acRef, test_identifier: tid }));
    expect(out).toContain("restored 1 emission");
    expect(out).toContain("verification is now: failing");
  });

  it("get_test_matrix rejects a raw UUID at the MCP boundary (std-10) [ac-8]", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const res = await callTool(actor.user.id, "get_test_matrix", {
      ref: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/UUID inputs no longer accepted/);
  });
});

describe("orphan awareness in the AC read surfaces (spec-127 ac-6)", () => {
  it("get_ac on a failing AC names the pinning identifier and points to the retire tool [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const { acRef, uid } = await seedAcWithRef("get_ac awareness AC");
    const tid = "tests/awareness.test.ts::renamed";
    await seedTestEvent({ acUid: uid, status: "fail", testIdentifier: tid });

    const out = text(await callTool(actor.user.id, "get_ac", { ref: acRef }));
    expect(out).toContain("failing");
    expect(out).toContain(tid);
    expect(out).toContain("discontinue_test_events");
    expect(out).toContain("orphaned-test-events");
  });

  it("get_ac on a verified AC stays quiet (no orphan hint) [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const { acRef, uid } = await seedAcWithRef("clean AC");
    await seedTestEvent({ acUid: uid, status: "pass", testIdentifier: "tests/clean.test.ts::ok" });
    const out = text(await callTool(actor.user.id, "get_ac", { ref: acRef }));
    expect(out).not.toContain("discontinue_test_events");
  });

  it("list_acs surfaces failing ACs with their pinning identifiers and the retire path [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const { specRef, uid } = await seedAcWithRef("list_acs awareness AC");
    const tid = "tests/list-aware.test.ts::renamed";
    await seedTestEvent({ acUid: uid, status: "fail", testIdentifier: tid });

    const out = text(await callTool(actor.user.id, "list_acs", { ref: specRef }));
    expect(out).toContain("failing AC");
    expect(out).toContain(tid);
    expect(out).toContain("discontinue_test_events");
    expect(out).toContain("orphaned-test-events");
  });

  it("get_information exposes the orphaned-test-events topic naming the retire tool [ac-6]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const out = text(await callTool(actor.user.id, "get_information", { topic: "orphaned-test-events" }));
    expect(out).toContain("discontinue_test_events");
    expect(out).toContain("restore_test_events");
    expect(out.toLowerCase()).toContain("orphan");
    // The trigger guidance: act after renaming/deleting a tagged test.
    expect(out.toLowerCase()).toMatch(/rename|delete/);
  });
});
