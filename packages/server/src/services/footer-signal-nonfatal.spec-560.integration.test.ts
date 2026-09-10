// spec-560 t-2 (dec-2) — the footer-signal class: decoration that could fail a
// committed write.
//
// `create_ac` commits the AC, then reads three more times purely to park
// `ctx.footerSlot.signal` — the DATA a footer is composed from. The footer signal is
// decoration by construction (spec-219 Phase 2: the handler parks data,
// composeGuidanceEnvelope owns every word), so nothing about it should be able to turn
// a committed AC into `Unexpected server error`. Today it can.
//
// End-to-end on purpose: ac-10's claim is about what `create_ac` RETURNS and what is
// left in the database, so it is driven through the real MCP tool registry rather than
// against the seam in isolation. `listAcsForBrief` is the throwing stand-in for any
// transient on that path — the prod defect was a Cloud SQL socket failure, and any read
// there produces the same lie.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, documents, acs, users } from "../db/schema.js";
import { createDocDraft } from "./documents.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-560";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

// The footer-signal read, forced to fail. Partial mock: `createAc` itself must stay
// real, or the test would prove nothing about a COMMITTED row surviving.
const listAcsForBrief = vi.hoisted(() => vi.fn());
vi.mock("./acs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./acs.js")>()),
  listAcsForBrief,
}));

const { createMcpServer } = await import("../mcp/tools.js");

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
  const server = createMcpServer(userId, undefined, undefined);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
afterAll(async () => {
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

let actor: { userId: string; memexId: string; nsSlug: string };
let specRef: string;
let docId: string;

beforeAll(async () => {
  const sub = `s560-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });

  const doc = await createDocDraft(mx.id, "Post-commit honesty", "Purpose.", "spec");
  created.docs.push(doc.id);
  docId = doc.id;
  actor = { userId: u.id, memexId: mx.id, nsSlug: ns.slug };
  specRef = `${ns.slug}/main/specs/${doc.handle}`;
});

describe("spec-560 ac-10 — footer-signal computation cannot fail a committed write", () => {
  it("create_ac still succeeds, names the AC ref, and leaves the row, when the footer read throws", async () => {
    tagAc(AC(10));
    tagAc(AC(1)); // scope: the response says the write LANDED, for a non-facet verb too.
    tagAc(AC(3)); // scope: and the operator still sees the fault (asserted below).

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listAcsForBrief.mockRejectedValue(
      new Error("write CONNECT_TIMEOUT /cloudsql/memex-ai-prod:us-east4:memex-prod"),
    );

    const res = await callTool(actor.userId, "create_ac", {
      ref: specRef,
      kind: "scope",
      statement: "A committed AC survives a failed footer read.",
    });

    const text = res.content.map((c) => c.text).join("\n");

    // 1. Not an error result, and not the lie.
    expect(res.isError).toBeFalsy();
    expect(text).not.toContain("Unexpected server error");

    // 2. The response names the row that exists, so the agent can act on it.
    expect(text).toMatch(/acs\/ac-\d+/);

    // 3. The row really is there — a success message over a rolled-back write would be
    //    a worse defect than the one being fixed.
    const rows = await db.select().from(acs).where(eq(acs.briefId, docId));
    expect(rows).toHaveLength(1);
    expect(rows[0].statement).toBe("A committed AC survives a failed footer read.");

    // 4. Silent to the agent, loud to the operator (std-14, std-50; spec-257 dec-2).
    const logged = errorSpy.mock.calls
      .flat()
      .find((a): a is Error => a instanceof Error && /CONNECT_TIMEOUT/.test(a.message));
    expect(logged, "the original error must reach the log with its stack").toBeInstanceOf(Error);
    expect(logged?.stack).toBeTruthy();

    errorSpy.mockRestore();
  });

  it("a clean create_ac is unchanged — the guard costs the happy path nothing", async () => {
    tagAc(AC(10));
    listAcsForBrief.mockResolvedValue([]);

    const res = await callTool(actor.userId, "create_ac", {
      ref: specRef,
      kind: "scope",
      statement: "The happy path still reads normally.",
    });

    expect(res.isError).toBeFalsy();
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/acs\/ac-\d+/);
  });
});
