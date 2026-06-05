// spec-156 ac-15 — MCP surface emission.
//
// The single MCP handler wrap (`withTelemetry` in mcp/tools.ts) must emit a
// read/advisory ChangeEvent on the unified bus for EVERY non-mutating tool
// invocation — channel 'mcp', with a narrative — so MCP activity appears in
// Pulse. This completes std-8's spec-60 "one site per channel" amendment on the
// MCP surface. Mutating tools already emit via mutate() inside their services,
// so the wrap must NOT double-emit for them.
//
// This file is TAGGED (tagAc → POSTs AC events to the prod memex). Run it with
// MEMEX_EMIT=false to suppress those posts in local/CI runs.
//
// Two layers of proof:
//   1. DB-free unit tests on the exported `emitMcpActivity` helper — the
//      load-bearing logic the wrap calls (channel 'mcp', narrative present,
//      silence for mutating tools, `called` for the Slack tool).
//   2. A DB-backed end-to-end test that dispatches a read tool (`get_doc`)
//      through a REAL `createMcpServer(...)` and asserts the wrap fired the
//      advisory event — proving the wiring, not just the helper.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  documents,
  users,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { toolSpecs } from "../agent/tool-specs.js";
import { createMcpServer, emitMcpActivity } from "./tools.js";

const AC_15 = "mindset-prod/memex-building-itself/specs/spec-156/acs/ac-15";

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec ${name} not found in catalogue`);
  return spec;
}

// ──────────────────────────────────────────────────────────────────────────
// Layer 1: DB-free unit tests on emitMcpActivity (the wrap's emission helper)
// ──────────────────────────────────────────────────────────────────────────

describe("spec-156 ac-15: emitMcpActivity (MCP read/advisory emission helper)", () => {
  beforeEach(() => bus._reset());

  it("emits a 'viewed' event with channel 'mcp' and a narrative for a read tool", () => {
    tagAc(AC_15);
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    emitMcpActivity(specByName("get_doc"), "m1", "u1", {
      ref: "ns/mx/specs/spec-7",
    });

    expect(received).toHaveLength(1);
    const e = received[0];
    expect(e.channel).toBe("mcp");
    expect(e.action).toBe("viewed");
    expect(e.memexId).toBe("m1");
    expect(e.userId).toBe("u1");
    expect(typeof e.narrative).toBe("string");
    expect(e.narrative).toBe("read spec-7");
    // The MCP surface has no doc-bound conversation, so docId/clientId are unset.
    expect(e.docId).toBeUndefined();
    expect(e.clientId).toBeUndefined();
  });

  it("emits 'searched' on the query entity for search_memex with channel 'mcp'", () => {
    tagAc(AC_15);
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    emitMcpActivity(specByName("search_memex"), "m1", "u1", {
      query: "auth flow",
      memex: "ns/mx",
    });

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe("mcp");
    expect(received[0].action).toBe("searched");
    expect(received[0].entity).toBe("query");
    expect(received[0].narrative).toBe('searched "auth flow"');
  });

  it("emits 'called' for memex__send_slack_message (no mutate() path of its own)", () => {
    tagAc(AC_15);
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    emitMcpActivity(specByName("memex__send_slack_message"), "m1", "u1", {
      channelOrUser: "#memex-ai",
      text: "hello",
    });

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe("mcp");
    expect(received[0].action).toBe("called");
    expect(received[0].narrative).toBe("messaged #memex-ai on Slack");
  });

  it("stays SILENT for a mutating tool — those emit via mutate(), no double-emit", () => {
    tagAc(AC_15);
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    // update_doc is a mutating tool (readOnlyHint:false) → deriveActivity null.
    emitMcpActivity(specByName("update_doc"), "m1", "u1", {
      ref: "ns/mx/specs/spec-7",
      status: "build",
    });

    expect(received).toHaveLength(0);
  });

  it("stays silent when no memexId resolved (nothing to attribute the activity to)", () => {
    tagAc(AC_15);
    const received: ChangeEvent[] = [];
    bus.subscribe({}, (e) => received.push(e));

    emitMcpActivity(specByName("get_doc"), undefined, "u1", {
      ref: "ns/mx/specs/spec-7",
    });

    expect(received).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 2: end-to-end through the REAL MCP server (proves the wrap wiring)
// ──────────────────────────────────────────────────────────────────────────

const cleanup = {
  namespaces: [] as string[],
  users: [] as string[],
};

afterAll(async () => {
  for (const id of cleanup.namespaces) {
    // namespace delete cascades to org/memex/memberships/docs.
    await db.delete(namespaces).where(eq(namespaces.id, id)).catch(() => {});
  }
  if (cleanup.users.length) {
    await db.delete(users).where(inArray(users.id, cleanup.users)).catch(() => {});
  }
});

// Enrol `userId` as an active administrator of a fresh namespace+org+memex so
// the MCP read gate (resolveWorkspaceForRead) authorizes the call.
async function makeMemexWithMember(
  userId: string,
  prefix: string,
): Promise<{ memexId: string; slug: string }> {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const slug = `${prefix}-${tail}`.toLowerCase().slice(0, 39);
  const { ns, org, memex } = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  await db
    .insert(orgMemberships)
    .values({ userId, orgId: org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: memex.id, slug: ns.slug };
}

// Bypass the SDK request/response envelope and call the registered handler the
// same way the overflow integration test does — pins the test to the wrap
// logic the spec actually invokes.
function harnessFor(userId: string) {
  const server = createMcpServer(userId);
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (input: Record<string, unknown>) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  return {
    async call(name: string, input: Record<string, unknown>) {
      const tool = registered[name];
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return (await tool.handler(input)) as { content: { text: string }[]; isError?: boolean };
    },
  };
}

describe("spec-156 ac-15: a read tool dispatched through the MCP wrap emits on the bus", () => {
  let userId: string;
  let memexId: string;
  let slug: string;
  let specHandle: string;

  beforeAll(async () => {
    const user = await upsertUserByEmail(`mcp-activity-${Date.now().toString(36)}@memex.ai`);
    userId = user.id;
    cleanup.users.push(userId);
    const made = await makeMemexWithMember(userId, "mcpact");
    memexId = made.memexId;
    slug = made.slug;
    cleanup.namespaces.push(
      (await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) }))!.namespaceId,
    );
    const spec = await createDocDraft(
      memexId,
      "Activity Fixture Spec",
      "Exercises the MCP read-tool bus emission.",
      "spec",
      undefined,
      undefined,
      userId,
    );
    specHandle = spec.handle;
  });

  it("get_doc through createMcpServer emits a viewed/channel-'mcp' event with narrative", async () => {
    tagAc(AC_15);
    bus._reset();
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId }, (e) => received.push(e));

    const harness = harnessFor(userId);
    const res = await harness.call("get_doc", {
      ref: `${slug}/main/specs/${specHandle}`,
    });
    expect(res.isError ?? false).toBe(false);

    // The wrap emits synchronously after fn() resolves — no microtask flush
    // needed (unlike the in-app path's detached emit).
    const advisory = received.filter((e) => e.action === "viewed" && e.channel === "mcp");
    expect(advisory).toHaveLength(1);
    expect(advisory[0].entity).toBe("document");
    expect(advisory[0].narrative).toBe(`read ${specHandle}`);
    expect(advisory[0].memexId).toBe(memexId);
    expect(advisory[0].userId).toBe(userId);
  });

  afterAll(async () => {
    // Spec rows cascade with the namespace delete in the file-level afterAll,
    // but drop documents explicitly first in case FK ordering bites.
    await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  });
});
