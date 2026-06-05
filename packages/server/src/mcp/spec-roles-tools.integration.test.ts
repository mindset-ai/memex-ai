// Integration tests for the spec-118 roles + assignment MCP tools, exercised
// end-to-end through the real createMcpServer registry against Postgres. Mirrors
// the wiring in spec-tools.integration.test.ts. The tools are thin handlers over
// services/doc-members.ts + services/doc-assignees.ts; here we prove they:
//   - promote a user to editor (ac-15) and read it back via get_spec_roles,
//   - demote the only editor leaving zero editors (ac-16, no last-editor lock),
//   - assign a user independent of role — a reviewer can be assigned (ac-12),
//   - emit a doc_assignee event on the unified bus when assigning (ac-20).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  docMembers,
  docAssignees,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { resolveRole } from "../services/doc-members.js";
import { listAssignees } from "../services/doc-assignees.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(docAssignees).where(inArray(docAssignees.docId, created.docs)).catch(() => {});
    await db.delete(docMembers).where(inArray(docMembers.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

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
  return await tool.handler(args, {} as unknown);
}

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [owner] = await db
    .insert(users)
    .values({ email: `mcp-roles-${sub}@memex.ai` } as typeof users.$inferInsert)
    .returning();
  created.users.push(owner.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: sub, kind: "org" } as typeof namespaces.$inferInsert)
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` } as typeof orgs.$inferInsert)
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: `Test ${sub}`, slug: "main", namespaceId: ns.id } as typeof memexes.$inferInsert)
    .returning();
  created.memexes.push(mx.id);
  await db
    .insert(orgMemberships)
    .values({ userId: owner.id, orgId: org.id, role: "administrator" } as typeof orgMemberships.$inferInsert);

  // A second org member to be the target of promote/assign verbs.
  const [member] = await db
    .insert(users)
    .values({ email: `mcp-roles-member-${sub}@memex.ai` } as typeof users.$inferInsert)
    .returning();
  created.users.push(member.id);
  await db
    .insert(orgMemberships)
    .values({ userId: member.id, orgId: org.id, role: "member" } as typeof orgMemberships.$inferInsert);

  return { owner, member, slug: ns.slug, memexId: mx.id };
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("roles");
});

async function makeSpec(title: string): Promise<{ id: string; ref: string }> {
  // Seed with the owner so the creator starts as the lone editor (seedCreatorAsEditor).
  const doc = await createDocDraft(actor.memexId, title, "purpose", "spec", undefined, undefined, actor.owner.id);
  created.docs.push(doc.id);
  return { id: doc.id, ref: `${actor.slug}/main/specs/${doc.handle}` };
}

describe("spec-118 roles + assignment MCP tools", () => {
  it("set_spec_role promotes a user to editor; get_spec_roles reads it back (ac-15)", async () => {
    tagAc(AC(15));
    const spec = await makeSpec("Roles Promote Spec");

    // Promote the member (by email) to editor.
    const res = await callTool(actor.owner.id, "set_spec_role", {
      ref: spec.ref,
      user: actor.member.email,
      role: "editor",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("role=editor");

    // The service-layer truth: the member now resolves to editor.
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("editor");

    // get_spec_roles lists the member among the editors.
    const roles = await callTool(actor.member.id, "get_spec_roles", { ref: spec.ref });
    expect(roles.isError).toBeFalsy();
    const text = roles.content[0].text;
    expect(text).toContain(actor.member.email);
    // The caller (member) is an editor now, so its own role reads editor.
    expect(text).toContain("editor");
  });

  it("set_spec_role demote removes the only editor, leaving zero editors (ac-16)", async () => {
    tagAc(AC(16));
    const spec = await makeSpec("Roles Demote Spec");
    // Creator (owner) is the sole editor at seed time.
    expect(await resolveRole(actor.memexId, spec.id, actor.owner.id)).toBe("editor");

    const res = await callTool(actor.owner.id, "set_spec_role", {
      ref: spec.ref,
      user: actor.owner.id,
      role: "reviewer",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("role=reviewer");

    // No last-editor lock: the owner now resolves to the implicit reviewer
    // default and the Spec carries zero editors.
    expect(await resolveRole(actor.memexId, spec.id, actor.owner.id)).toBe("reviewer");
    const editorRows = await db
      .select()
      .from(docMembers)
      .where(eq(docMembers.docId, spec.id));
    expect(editorRows.length).toBe(0);
  });

  it("assign_spec assigns a reviewer — assignment is independent of role (ac-12)", async () => {
    tagAc(AC(12));
    const spec = await makeSpec("Roles Assign Spec");
    // The member is a reviewer on this Spec (no editor row).
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");

    const res = await callTool(actor.owner.id, "assign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(res.isError).toBeFalsy();
    // std-10: terse output names the assignee by email, never a raw UUID.
    expect(res.content[0].text).toContain(`assigned=${actor.member.email}`);
    expect(res.content[0].text).not.toContain(actor.member.id);

    // Assigned despite being a reviewer; and assigning wrote NO editor row.
    const assignees = await listAssignees(actor.memexId, spec.id);
    expect(assignees.map((a) => a.userId)).toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");

    // unassign_spec reverses it; the role is still untouched.
    const un = await callTool(actor.owner.id, "unassign_spec", {
      ref: spec.ref,
      user: actor.member.email,
    });
    expect(un.isError).toBeFalsy();
    const after = await listAssignees(actor.memexId, spec.id);
    expect(after.map((a) => a.userId)).not.toContain(actor.member.id);
    expect(await resolveRole(actor.memexId, spec.id, actor.member.id)).toBe("reviewer");
  });

  it("assign_spec emits a doc_assignee 'created' event on the unified bus (ac-20)", async () => {
    tagAc(AC(20));
    const spec = await makeSpec("Roles Assign Bus Spec");
    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe(
      { memexId: actor.memexId, entity: "doc_assignee" },
      (e) => events.push(e),
    );
    try {
      await callTool(actor.owner.id, "assign_spec", { ref: spec.ref, user: actor.member.email });
    } finally {
      unsub();
    }
    const created = events.find((e) => e.docId === spec.id && e.action === "created");
    expect(created, "expected a doc_assignee created event for the assigned Spec").toBeDefined();
    expect(created!.entity).toBe("doc_assignee");
  });

  it("assign_spec self-assigns the caller when user is omitted", async () => {
    tagAc(AC(12));
    const spec = await makeSpec("Roles Self Assign Spec");
    const res = await callTool(actor.member.id, "assign_spec", { ref: spec.ref });
    expect(res.isError).toBeFalsy();
    // Self-assign renders "(you)" rather than echoing the caller's UUID (std-10).
    expect(res.content[0].text).toContain('assigned=');
    expect(res.content[0].text).not.toContain(actor.member.id);
    const assignees = await listAssignees(actor.memexId, spec.id);
    expect(assignees.map((a) => a.userId)).toContain(actor.member.id);
  });
});
