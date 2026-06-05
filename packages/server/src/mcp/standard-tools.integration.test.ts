// Integration tests for the t-10 standard MCP tools (doc-10 Slice 4). End-to-end through
// createMcpServer against a real Postgres — covers tool registration, success paths, and
// the source-stamping contract (drift comments are always source='agent' regardless of
// what the caller tries to pass).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  docComments,
  tasks,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
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
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-bp-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: `Test ${sub}`, slug: "main", namespaceId: ns.id } as any)
    .returning();
  created.memexes.push(a.id);
  await db
    .insert(orgMemberships)
    .values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
  return { user: u, account: { ...a, slug: ns.slug } };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  // Per dec-1 of doc-20 the MCP surface defaults to terse output. These pre-
  // doc-20 tests assert against the verbose markdown surface, so opt in via
  // the documented `verbose: true` escape hatch unless the test sets it
  // explicitly. New tests covering the terse contract live in
  // `mcp/tools.overflow.integration.test.ts` / `agent/tool-specs.*`.
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("bp");
});

// SKIP: doc-24 — Standard MCP tools (flag_drift, propose_standard_change, search_standards) hidden; restore alongside the tools.
describe.skip("Standard MCP tools (post-doc-14)", () => {
  it("registers the consolidated Standard-related tools", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // Standards-named verbs survive the consolidation.
    expect(names).toContain("flag_drift");
    expect(names).toContain("propose_standard_change");
    expect(names).toContain("search_standards");
    // Generic doc tools handle list/get/create/update.
    expect(names).toContain("list_docs");
    expect(names).toContain("get_doc");
    expect(names).toContain("create_doc");
    expect(names).toContain("update_section");
  });

  it("create_standard creates a docType='standard' document (via create_doc)", async () => {
    const result = await callTool(actor.user.id, "create_doc", {
      memex: actor.account.slug,
      docType: "standard",
      title: "Caching",
      description: "How we cache reads",
      sections: [
        { sectionType: "do", content: "Use write-through" },
        { sectionType: "dont", content: "No TTL" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("Caching");
    expect(text).toContain("Standard |");

    const doc = await db.query.documents.findFirst({
      where: eq(documents.title, "Caching"),
    });
    expect(doc).toBeDefined();
    expect(doc!.docType).toBe("standard");
    expect(doc!.memexId).toBe(actor.account.id);
    created.docs.push(doc!.id);
  });

  it("list_standards returns only standard-typed docs (via list_docs)", async () => {
    // Seed a non-standard to verify filtering.
    const spec = await createDocDraft(actor.account.id, "MCP Spec", "purpose", "spec");
    created.docs.push(spec.id);

    const result = await callTool(actor.user.id, "list_docs", {
      memex: actor.account.slug,
      docType: "standard",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("# Standards");
    expect(text).toContain("Caching");
    expect(text).not.toContain("MCP Spec");
  });

  it("get_standard returns full standard with sections (via get_doc)", async () => {
    // Create a standard via the service, fetch via MCP.
    const bpResult = await callTool(actor.user.id, "create_doc", {
      memex: actor.account.slug,
      docType: "standard",
      title: "GetMeBP",
      sections: [{ sectionType: "do", content: "rule 1" }],
    });
    expect(bpResult.isError).toBeFalsy();
    const doc = await db.query.documents.findFirst({
      where: eq(documents.title, "GetMeBP"),
    });
    created.docs.push(doc!.id);

    const result = await callTool(actor.user.id, "get_doc", {
      docId: doc!.id,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("GetMeBP");
    expect(text).toContain("rule 1");
  });

  // Post doc-14: get_doc is generic — non-standard docs return their state rather
  // than erroring. The "must be a standard" check now happens at the named-verb
  // boundary (flag_drift / propose_standard_change).

  // update_standard was dropped in doc-14: the instruction-comment workflow folded
  // into update_section + propose_standard_change. The plan_revision-comment path
  // is exercised via propose_standard_change in propose-standard-change.integration.test.ts.

  it("flag_drift creates a typed drift comment sourced 'agent'", async () => {
    const bpResult = await callTool(actor.user.id, "create_doc", {
      memex: actor.account.slug,
      docType: "standard",
      title: "DriftMe",
      sections: [{ sectionType: "verify", content: "verify deploys via kubectl" }],
    });
    expect(bpResult.isError).toBeFalsy();
    const doc = await db.query.documents.findFirst({
      where: eq(documents.title, "DriftMe"),
    });
    created.docs.push(doc!.id);

    const sections = await db.query.docSections.findMany({
      where: (s, { eq }) => eq(s.docId, doc!.id),
    });
    const verify = sections.find((s) => s.sectionType === "verify")!;

    const result = await callTool(actor.user.id, "flag_drift", {
      standardSectionId: verify.id,
      observation: "Repo uses ArgoCD now, not kubectl.",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Drift flagged/);

    const cms = await db.query.docComments.findMany({
      where: eq(docComments.sectionId, verify.id),
    });
    expect(cms).toHaveLength(1);
    expect(cms[0].commentType).toBe("drift");
    expect(cms[0].source).toBe("agent");
  });

  // affected_by_decision was dropped in doc-14: the migration map points users at
  // search_standards({query: 'dec-N'}) instead. The two tests below covered the
  // dedicated tool's matching + empty-result paths; the equivalent search-side
  // coverage lives in standards-search.integration tests.

  it("create_standard rejects empty sections array via Zod schema (via create_doc)", async () => {
    const result = await callTool(actor.user.id, "create_doc", {
      memex: actor.account.slug,
      docType: "standard",
      title: "Bad",
      sections: [],
    });
    // Empty sections is now caught by create_doc's branch (Zod min(1) schema removed
    // by the consolidation; the validation lives in createStandard service).
    expect(result.isError).toBe(true);
  });

  it("flag_drift rejects sections that aren't on a standard", async () => {
    const spec = await createDocDraft(actor.account.id, "NotBP", "p", "spec");
    created.docs.push(spec.id);
    const sections = await db.query.docSections.findMany({
      where: (s, { eq }) => eq(s.docId, spec.id),
    });
    const result = await callTool(actor.user.id, "flag_drift", {
      standardSectionId: sections[0].id,
      observation: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a standard/);
  });
});
