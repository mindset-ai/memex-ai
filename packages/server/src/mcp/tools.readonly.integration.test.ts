// spec-111 t-4 — MCP read/write gating + server-side readOnly flag.
//
// End-to-end through createMcpServer against a real Postgres. A non-member
// (no org_membership row) drives tools against a PUBLIC memex:
//   - A readOnlyHint:true tool (list_docs / get_doc) SUCCEEDS — the looser
//     canReadMemex gate lets any reader through on a public memex (ac-2).
//   - A write tool (create_doc / update_section, readOnlyHint:false) is
//     REJECTED with the exact message "Public Memexes are read-only for
//     non-members" — the readOnly flag stamped by the resolve path, enforced
//     against the tool's own readOnlyHint annotation (ac-12).
//
// The gate reuses the existing readOnlyHint metadata; there is no hand-kept
// read/write tool list. Org members are unaffected — verified by a control.
//
// Tagged to:
//   mindset-prod/memex-building-itself/specs/spec-111/acs/ac-2  (reads succeed)
//   mindset-prod/memex-building-itself/specs/spec-111/acs/ac-12 (writes 403)

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
  tasks,
  docSections,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { READ_ONLY_PUBLIC_MESSAGE } from "./auth.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_2 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-2";
const AC_12 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-12";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(docSections).where(inArray(docSections.docId, created.docs)).catch(() => {});
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

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

// Invoke a registered MCP tool as `userId`. Mirrors the helper in
// standard-tools.integration.test.ts but threads userId per call so we can
// exercise non-member vs member without rebuilding setup.
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
  const withVerbose = "verbose" in args ? args : { ...args, verbose: true };
  return await tool.handler(withVerbose, {} as unknown);
}

async function makeUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({
      email: `mcp-ro-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memex.ai`,
    } as any)
    .returning();
  created.users.push(u.id);
  return u;
}

// Org namespace + org + one memex with the requested visibility. Returns the
// `<namespace>/<memex>` identifier the scoped tools expect.
async function makeAccount(
  sub: string,
  visibility: "public" | "private",
): Promise<{ id: string; ref: string; orgId: string }> {
  const slug = `${sub}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: sub } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: sub, slug: "main", namespaceId: ns.id, visibility } as any)
    .returning();
  created.memexes.push(a.id);
  return { id: a.id, ref: `${ns.slug}/main`, orgId: org.id };
}

describe("spec-111 t-4 MCP read/write gating", () => {
  describe("public memex — non-member reads succeed (ac-2)", () => {
    it("list_docs (readOnlyHint:true) succeeds for a non-member on a public memex", async () => {
      tagAc(AC_2);
      const nonMember = await makeUser("read-list");
      const acct = await makeAccount("read-list", "public");
      // Seed a doc so the listing has content to render.
      const doc = await createDocDraft(acct.id, "Public Spec", "purpose", "spec");
      created.docs.push(doc.id);

      const result = await callTool(nonMember.id, "list_docs", { memex: acct.ref });

      // The read passes the gate: no error, and crucially NOT the read-only
      // rejection — a non-member can list a public memex without membership.
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).not.toContain(READ_ONLY_PUBLIC_MESSAGE);
      expect(result.content[0].text).not.toContain("not a member");
      // It renders the Specs surface (the draft seeded above is not yet
      // "active", so list_docs reports the active set rather than the title).
      expect(result.content[0].text).toContain("Specs");
    });

    it("get_doc via canonical ref (readOnlyHint:true, resolveRef path) succeeds for a non-member", async () => {
      tagAc(AC_2);
      const nonMember = await makeUser("read-get");
      const acct = await makeAccount("read-get", "public");
      const doc = await createDocDraft(acct.id, "Readable Spec", "purpose", "spec");
      created.docs.push(doc.id);

      // Canonical doc ref: `<ns>/main/specs/<handle>` — exercises the
      // resolveRefForUser read-gate path (distinct from resolveMemex).
      const docRef = `${acct.ref}/specs/${doc.handle}`;
      const result = await callTool(nonMember.id, "get_doc", { ref: docRef });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("Readable Spec");
    });
  });

  describe("public memex — non-member writes rejected with exact message (ac-12)", () => {
    it("create_doc (readOnlyHint:false) returns the exact read-only message", async () => {
      tagAc(AC_12);
      const nonMember = await makeUser("write-create");
      const acct = await makeAccount("write-create", "public");

      const result = await callTool(nonMember.id, "create_doc", {
        memex: acct.ref,
        title: "Should Not Exist",
        purpose: "attempted write by a non-member",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(READ_ONLY_PUBLIC_MESSAGE);
      expect(result.content[0].text).toBe(
        "Public Memexes are read-only for non-members",
      );

      // Nothing was created.
      const leaked = await db.query.documents.findFirst({
        where: eq(documents.title, "Should Not Exist"),
      });
      expect(leaked).toBeUndefined();
    });

    it("update_section via canonical ref (readOnlyHint:false, resolveRef path) returns the exact read-only message", async () => {
      tagAc(AC_12);
      const nonMember = await makeUser("write-update");
      const acct = await makeAccount("write-update", "public");
      // A real section to target — owned by the public memex.
      const doc = await createDocDraft(acct.id, "Guarded Spec", "purpose", "spec");
      created.docs.push(doc.id);
      const section = await db.query.docSections.findFirst({
        where: eq(docSections.docId, doc.id),
      });
      expect(section).toBeDefined();

      // Canonical section ref — exercises the resolveRefForUser write-gate path.
      const sectionRef = `${acct.ref}/specs/${doc.handle}/sections/s-${section!.seq}`;
      const result = await callTool(nonMember.id, "update_section", {
        ref: sectionRef,
        content: "non-member attempted edit",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Public Memexes are read-only for non-members",
      );
    });
  });

  describe("public memex — org member retains write (control, ac-12 boundary)", () => {
    it("create_doc succeeds for an org member of a public memex", async () => {
      tagAc(AC_12);
      const member = await makeUser("member-write");
      const acct = await makeAccount("member-write", "public");
      await db
        .insert(orgMemberships)
        .values({ userId: member.id, orgId: acct.orgId, role: "member" } as any);

      const result = await callTool(member.id, "create_doc", {
        memex: acct.ref,
        title: "Member Created Spec",
        purpose: "members can still write to public memexes",
      });

      expect(result.isError).toBeFalsy();
      const doc = await db.query.documents.findFirst({
        where: eq(documents.title, "Member Created Spec"),
      });
      expect(doc).toBeDefined();
      created.docs.push(doc!.id);
    });
  });
});
