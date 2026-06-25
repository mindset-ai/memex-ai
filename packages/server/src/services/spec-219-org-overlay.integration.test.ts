// spec-219 ac-4 — the org_scaffold_additions tenant overlay is honoured
// unchanged: same targeting/scoping, appended in the footer exactly as today.
// The centralization (one seat) must not alter tenant overlays — the seat still
// threads ctx.getOrgBlocksForNudge() → toNudge, so an enabled Org block still
// rides the footer.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  users,
  orgScaffoldAdditions,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { createDocDraft } from "./documents.js";
import { createOrgScaffoldAddition } from "./scaffold-additions.js";
import { FOOTER_DELIMITER, splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  scaffolds: [] as string[],
};

afterAll(async () => {
  if (created.scaffolds.length)
    await db.delete(orgScaffoldAdditions).where(inArray(orgScaffoldAdditions.id, created.scaffolds)).catch(() => {});
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, orgId: org.id, memexId: a.id, nsSlug: ns.slug };
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec219-org");
});

describe("ac-4 — org_scaffold_additions tenant overlay honoured unchanged", () => {
  it("an enabled Org block still rides the footer (same targeting, in the footer region)", async () => {
    tagAc(AC(4));
    const sentinel = `ORG-OVERLAY-${Math.random().toString(36).slice(2, 10)}`;
    // Phase-agnostic target ({}) — matches every phase, exactly as a tenant-wide
    // scaffold addition does in production.
    const block = await createOrgScaffoldAddition({
      orgId: actor.orgId,
      authorId: actor.user.id,
      target: {},
      text: sentinel,
      rationale: "spec-219 ac-4 fixture — tenant overlay must survive centralization.",
      enabled: true,
    });
    created.scaffolds.push(block.id);

    const doc = await createDocDraft(actor.memexId, "Org Overlay Spec", "Purpose.", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;

    const res = await callTool(actor.user.id, "get_doc", { ref, verbose: true });
    const text = res.content.map((c) => c.text).join("\n");

    // Honoured: the overlay rides the FOOTER (past the delimiter), not the body.
    const { body, footer } = splitToolResult(text);
    expect(footer).toContain(sentinel);
    expect(body).not.toContain(sentinel);
    // Not doubled by the centralization — exactly one occurrence.
    expect(text.split(sentinel).length - 1).toBe(1);
    // Sanity: there is a real footer region to ride.
    expect(text).toContain(FOOTER_DELIMITER);
  });

  it("a disabled Org block does NOT leak into the footer (scoping unchanged)", async () => {
    tagAc(AC(4));
    const sentinel = `ORG-DISABLED-${Math.random().toString(36).slice(2, 10)}`;
    const block = await createOrgScaffoldAddition({
      orgId: actor.orgId,
      authorId: actor.user.id,
      target: {},
      text: sentinel,
      rationale: "spec-219 ac-4 fixture — disabled overlay must stay off the footer.",
      enabled: false,
    });
    created.scaffolds.push(block.id);

    const doc = await createDocDraft(actor.memexId, "Org Disabled Overlay Spec", "Purpose.", "spec");
    created.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;

    const res = await callTool(actor.user.id, "get_doc", { ref, verbose: true });
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).not.toContain(sentinel);
  });
});
