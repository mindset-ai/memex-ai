// Per doc-20 t-11: end-to-end overflow guard against the live MCP server.
//
// These tests construct an `McpServer` via `createMcpServer(userId)` and
// dispatch tool calls through it (not directly against `spec.handler`), so
// the wiring at `mcp/tools.ts` — including the `verbose: input.verbose === true`
// flip from t-3 — is exercised.
//
// Three contracts pinned:
//
//   1. **Byte-budget guard on terse defaults.** Every mutating tool's
//      default-shape response stays under 2KB even on a Spec that
//      mirrors the doc-16 baseline that triggered this Spec
//      (~25 tasks + 5 decisions + 8 sections).
//
//   2. **`verbose: true` escape-hatch parity.** Passing `verbose: true`
//      via MCP reproduces the pre-flip behaviour byte-for-byte against
//      a direct `spec.handler({...}, ctx.verbose=true)` call (after
//      normalising the synthesised workspace URL, which differs between
//      the MCP path's tenant-URL lookup and the spec-handler's test
//      stub).
//
//   3. **`verbose: true` full-state on a large doc.** Sanity: the
//      escape hatch actually renders the full doc state — payload is
//      large and includes the doc handle.
//
// SKIP REGRESSION (t-12): reverting `verbose: input.verbose === true` back
// to `verbose: true` in `mcp/tools.ts` should fail Test 1 (the < 2KB
// assertions) while Tests 2/3 still pass — that's exactly the diagnostic
// the verify step from t-12 captures.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FOOTER_DELIMITER } from "./footer-delimiter.js";
import { db } from "../db/connection.js";
import {
  memexes,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  namespaces,
  orgs,
  orgMemberships,
  users,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { createMcpServer } from "./tools.js";
import { toolSpecs, type ToolCtx } from "../agent/tool-specs.js";

// 2KB. Per §3 Testing #3 of doc-20: a terse response is typically <500
// bytes; 2KB is 4× headroom. The contract, not the expected size — if
// future churn drifts terse output above 2KB, this assertion catches it.
const TERSE_BUDGET_BYTES = 2048;

// ──────────────────────────────────────────────────────────────────────────
// Fixtures: a Memex owned by an org the test user administers, with a
// Spec sized to mirror the doc-16 baseline.
// ──────────────────────────────────────────────────────────────────────────

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
  users: [] as string[],
  orgs: [] as string[],
  namespaces: [] as string[],
};

afterAll(async () => {
  if (cleanup.memexes.length) {
    await db
      .delete(docComments)
      .where(inArray(docComments.memexId, cleanup.memexes))
      .catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, cleanup.docs)).catch(() => {});
    await db
      .delete(decisions)
      .where(inArray(decisions.docId, cleanup.docs))
      .catch(() => {});
    await db
      .delete(docSections)
      .where(inArray(docSections.docId, cleanup.docs))
      .catch(() => {});
    await db
      .delete(documents)
      .where(inArray(documents.id, cleanup.docs))
      .catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  if (cleanup.orgs.length) {
    await db
      .delete(orgMemberships)
      .where(inArray(orgMemberships.orgId, cleanup.orgs))
      .catch(() => {});
    await db.delete(orgs).where(inArray(orgs.id, cleanup.orgs)).catch(() => {});
  }
  if (cleanup.namespaces.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, cleanup.namespaces))
      .catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

// Sets up: namespace + org + memex + the given user enrolled as active
// administrator. Returns memexId so tests can scope operations.
async function makeMemexWithMember(userId: string, prefix: string): Promise<string> {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const slug = `${prefix}-${tail}`.toLowerCase().slice(0, 39);
  return db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    cleanup.namespaces.push(ns.id);
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Overflow ${prefix}` })
      .returning();
    cleanup.orgs.push(org.id);
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [mx] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    cleanup.memexes.push(mx.id);
    await tx
      .insert(orgMemberships)
      .values({ userId, orgId: org.id, role: "administrator" })
      .onConflictDoNothing();
    return mx.id;
  });
}

interface McpServerHarness {
  callback: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

// `_registeredTools[name].handler` is the function we registered via
// `server.tool(name, desc, schema, handler)` — same shape used by the
// SDK's executeToolHandler path. Bypassing the full SDK request/response
// envelope keeps this test pinned to the handler logic the spec actually
// invokes; zod validation is exercised separately by `tool-specs.audit.*`.
function harnessFor(userId: string): McpServerHarness {
  const server = createMcpServer(userId);
  const registered = (server as unknown as {
    _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown> }>;
  })._registeredTools;
  return {
    async callback(name, input) {
      const tool = registered[name];
      if (!tool) throw new Error(`Tool ${name} not registered on MCP server`);
      return (await tool.handler(input)) as {
        content: { text: string }[];
        isError?: boolean;
      };
    },
  };
}

let testUserId: string;
let memexId: string;
let memexSlugs: { namespace: string; memex: string };
let largeSpecId: string;
let largeSpecHandle: string;
let aTaskSeq: number;
let aSectionSeq: number;
let aDecisionSeq: number;

function refForDoc(handle: string): string {
  return `${memexSlugs.namespace}/${memexSlugs.memex}/specs/${handle}`;
}
function refForChild(
  handle: string,
  type: "sections" | "decisions" | "tasks" | "comments",
  seq: number,
): string {
  const p = type === "sections" ? "s" : type === "decisions" ? "dec" : type === "tasks" ? "t" : "c";
  return `${memexSlugs.namespace}/${memexSlugs.memex}/specs/${handle}/${type}/${p}-${seq}`;
}

beforeAll(async () => {
  // Pin to a stable test email; upsertUserByEmail makes idempotency cheap.
  const user = await upsertUserByEmail(
    `mcp-overflow-${Date.now().toString(36)}@memex.ai`,
  );
  testUserId = user.id;
  cleanup.users.push(testUserId);

  memexId = await makeMemexWithMember(testUserId, "ovf");

  // Capture slugs so tests can compose canonical refs.
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, mx!.namespaceId),
  });
  memexSlugs = { namespace: ns!.slug, memex: mx!.slug };

  // Build a "large" doc that mirrors the doc-16 baseline.
  const spec = await createDocDraft(
    memexId,
    "Large Spec Fixture",
    "Spec of doc-16 scale used to exercise terse-default byte budgets.",
    "spec",
    undefined,
    undefined,
    testUserId,
  );
  largeSpecId = spec.id;
  largeSpecHandle = spec.handle;
  cleanup.docs.push(spec.id);
  await db
    .update(documents)
    .set({ status: "build", statusChangedAt: new Date() })
    .where(eq(documents.id, spec.id));

  // 8 sections (one already auto-added by createDocDraft as 'overview',
  // so add 7 more).
  for (let i = 1; i <= 7; i++) {
    await addSection(
      memexId,
      spec.id,
      `section-${i}`,
      `Body content for section ${i}. `.repeat(20),
      `Section ${i}`,
    );
  }
  // Capture one section seq for narrow probes (refs are seq-based).
  const secs = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, spec.id));
  aSectionSeq = secs[0].seq;

  // 5 decisions.
  for (let i = 1; i <= 5; i++) {
    await db.insert(decisions).values({
      memexId,
      docId: spec.id,
      seq: i,
      title: `Decision ${i} title goes here`,
      context: `Decision ${i} context, some lorem to bulk up the doc. `.repeat(5),
    } as never);
  }
  const decs = await db
    .select()
    .from(decisions)
    .where(eq(decisions.docId, spec.id));
  aDecisionSeq = decs[0].seq;

  // 25 tasks.
  for (let i = 1; i <= 25; i++) {
    await db.insert(tasks).values({
      memexId,
      docId: spec.id,
      seq: i,
      title: `Task ${i} title for the overflow fixture`,
      description: `Task ${i} description with some bulk content. `.repeat(5),
    } as never);
  }
  const ts = await db.select().from(tasks).where(eq(tasks.docId, spec.id));
  aTaskSeq = ts[0].seq;
});

// ──────────────────────────────────────────────────────────────────────────
// Test 1: byte-budget guard on terse defaults
// ──────────────────────────────────────────────────────────────────────────

describe("mcp/tools: terse-default protects against response overflow (doc-20 t-11)", () => {
  it("create_task on a large doc returns < 2KB by default", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("create_task", {
      ref: refForDoc(largeSpecHandle),
      title: "Overflow probe task",
      description: "Probe.",
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `terse create_task errored: ${text}`).toBe(false);
    expect(
      text.length,
      `terse create_task response was ${text.length} bytes:\n${text.slice(0, 300)}`,
    ).toBeLessThan(TERSE_BUDGET_BYTES);
  });

  it("update_task(status='in_progress') on a large doc returns < 2KB by default", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("update_task", {
      ref: refForChild(largeSpecHandle, "tasks", aTaskSeq),
      status: "in_progress",
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `terse update_task errored: ${text}`).toBe(false);
    expect(text.length).toBeLessThan(TERSE_BUDGET_BYTES);
  });

  it("add_section on a large doc returns < 2KB by default", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("add_section", {
      ref: refForDoc(largeSpecHandle),
      sectionType: `probe-section-${Math.random().toString(36).slice(2, 8)}`,
      content: "probe body",
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `terse add_section errored: ${text}`).toBe(false);
    expect(text.length).toBeLessThan(TERSE_BUDGET_BYTES);
  });

  it("resolve_decision on a large doc returns < 2KB by default", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("resolve_decision", {
      ref: refForChild(largeSpecHandle, "decisions", aDecisionSeq),
      resolution: "Probe resolution.",
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `terse resolve_decision errored: ${text}`).toBe(false);
    expect(text.length).toBeLessThan(TERSE_BUDGET_BYTES);
  });

  it("update_doc(title) on a large doc returns < 2KB by default", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("update_doc", {
      ref: refForDoc(largeSpecHandle),
      title: "Large Spec Fixture (renamed by probe)",
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `terse update_doc errored: ${text}`).toBe(false);
    expect(text.length).toBeLessThan(TERSE_BUDGET_BYTES);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 2: verbose:true escape-hatch parity
// ──────────────────────────────────────────────────────────────────────────

describe("mcp/tools: verbose:true escape hatch reproduces direct-handler output (doc-20 t-11)", () => {
  // The MCP path resolves workspaceUrl from the tenant slug; the direct
  // handler path uses a synthesised stub. Normalise both URL forms before
  // comparing so the test pins behaviour, not environment.
  function stripUrls(s: string): string {
    return s.replace(/https?:\/\/[^\s)]+/g, "<URL>");
  }

  function specByName(name: string) {
    const spec = toolSpecs.find((s) => s.name === name);
    if (!spec) throw new Error(`Spec ${name} not found`);
    return spec;
  }

  function ctxVerbose(memexIdToReturn: string): ToolCtx {
    return {
      userId: testUserId,
      resolveMemexFromEntity: async () => memexIdToReturn,
      resolveMemex: async () => memexIdToReturn,
      resolveRef: async (ref: string) => {
        const { parseRef } = await import("../services/refs.js");
        const { resolveRef: resolveCanonicalRef } = await import("../services/resolver.js");
        const { ValidationError, NotFoundError } = await import("../types/errors.js");
        const parsed = parseRef(ref);
        if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
        const result = await resolveCanonicalRef(parsed.ref);
        if ("redirected" in result) {
          throw new ValidationError(
            `Ref redirected: "${ref}" now lives at "${result.newRef}". Retry with the new ref.`,
          );
        }
        if ("notFound" in result) {
          throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
        }
        const entity = result.entity;
        const doc = "doc" in entity ? entity.doc : entity.row;
        return {
          entity,
          memexId: doc.memexId,
          doc,
          slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
        };
      },
      workspaceUrl: async () => "https://test.example",
      verbose: true,
    };
  }

  it("update_section: verbose:true via MCP matches direct-handler verbose:true", async () => {
    const harness = harnessFor(testUserId);
    const ref = refForChild(largeSpecHandle, "sections", aSectionSeq);
    const viaMcp = await harness.callback("update_section", {
      ref,
      content: "Parity probe body.",
      verbose: true,
    });
    const viaCtx = await specByName("update_section").handler(
      { ref, content: "Parity probe body." },
      ctxVerbose(memexId),
    );
    // spec-203 ac-15: the footer now rides the single choke point
    // (runToolWithSpecTraffic), not the handler. So the MCP response is the
    // direct-handler BODY (byte-for-byte) plus the platform footer the seat
    // attaches. The direct handler call bypasses the choke point, so it carries
    // no footer — compare the bodies, and confirm the footer is the MCP addition.
    const [mcpBody] = viaMcp.content[0].text.split(FOOTER_DELIMITER);
    expect(stripUrls(mcpBody).trimEnd()).toBe(stripUrls(viaCtx).trimEnd());
    expect(viaMcp.content[0].text).toContain(FOOTER_DELIMITER);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 3: verbose:true full-state on a large doc
// ──────────────────────────────────────────────────────────────────────────

describe("mcp/tools: verbose:true returns the full markdown surface (doc-20 t-11)", () => {
  it("create_task with verbose:true returns the full doc state (>4KB; contains handle)", async () => {
    const harness = harnessFor(testUserId);
    const result = await harness.callback("create_task", {
      ref: refForDoc(largeSpecHandle),
      title: "Verbose probe task",
      description: "Probe verbose path.",
      verbose: true,
    });
    const text = result.content[0].text;
    expect(result.isError ?? false, `verbose create_task errored: ${text}`).toBe(false);
    expect(text.length, `verbose response was ${text.length} bytes`).toBeGreaterThan(4096);
    expect(text).toContain(largeSpecHandle);
  });
});
