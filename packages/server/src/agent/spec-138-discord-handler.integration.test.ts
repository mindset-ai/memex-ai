// spec-138 t-3 — HANDLER-LAYER verification for the memex__send_discord_message
// tool (issue-1, issue-2).
//
// The original spec-138 tests only exercised postToDiscord() directly, which
// bypasses the tool handler's footer-construction logic. This file invokes the
// real handler with a hand-built ToolCtx so the three backlink paths are
// asserted at the layer that actually ships:
//
//   ac-8  (dec-5): embed omitted ONLY when neither specRef NOR a current Spec
//                  context (ctx.currentDocId) is present; auto-attached when a
//                  Spec context IS present.
//   ac-9  (dec-2): explicit specRef → payload carries content + a 1-element embeds array.
//   ac-10 (dec-3): the embed rides `description` as `**Spec:** [<title>](<url>)`,
//                  built by the HANDLER from the resolved Spec (not a passthrough).
//
// Real DB is used for getOrgIdForMemex / getDiscordWebhook / memexSlugsById /
// the documents lookup; only `fetch` (the Discord POST boundary) is stubbed so
// we can capture the wire payload without a live webhook.

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  orgDiscordWebhooks,
  documents,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { toolSpecs, type ToolCtx, type ResolvedRef } from "./tool-specs.js";
import { buildTenantUrl } from "../services/shared/tenant-url.js";

const AC_8  = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-8";
const AC_9  = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-9";
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-10";

const WEBHOOK_URL = "https://discord.com/api/webhooks/seed/spec-138";

const discordSpec = toolSpecs.find((s) => s.name === "memex__send_discord_message")!;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[], orgs: [] as string[] };

afterAll(async () => {
  if (created.orgs.length)
    await db.delete(orgDiscordWebhooks).where(inArray(orgDiscordWebhooks.orgId, created.orgs)).catch(() => {});
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

// Seed a user + org + namespace + memex, an org membership, and a Discord
// webhook for that org. Mirrors the setupActor pattern in
// update-task-footer.integration.test.ts, plus the webhook row.
async function setup(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  created.orgs.push(org.id);
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  await db.insert(orgDiscordWebhooks).values({ orgId: org.id, webhookUrl: WEBHOOK_URL, channelName: "test-chan" });
  return { userId: u.id, memexId: mx.id, nsSlug: ns.slug };
}

// Create a real spec doc via the MCP tool so the documents row has a valid
// handle + title for the currentDocId auto-footer path.
interface ToolResult { content: Array<{ type: string; text: string }> }
async function createSpec(userId: string, nsSlug: string, memexId: string, title: string): Promise<{ id: string; handle: string }> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> }> })._registeredTools;
  const out = (await registry["create_doc"].handler({ memex: `${nsSlug}/main`, title, purpose: "Probe." }, {})).content.map((c) => c.text).join("\n");
  const handle = out.match(/specs\/(spec-\d+)/)![1];
  // Scope by memexId: `handle` is unique only per-memex (documents_memex_id_handle_unique),
  // so under parallel test shards a bare handle lookup can grab another memex's doc.
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.memexId, memexId), eq(documents.handle, handle)),
  });
  created.docs.push(doc!.id);
  return { id: doc!.id, handle };
}

let captured: { url: string; body: any } | null = null;

beforeEach(() => {
  captured = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return { ok: true, status: 204, statusText: "No Content" } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Build a ToolCtx with only the fields the discord handler reads. resolveRef
// and currentDocId are the levers the three paths turn on.
function makeCtx(
  memexId: string,
  userId: string,
  opts: { currentDocId?: string; resolveRef?: (ref: string) => Promise<ResolvedRef> } = {},
): ToolCtx {
  return {
    userId,
    resolveMemex: async () => memexId,
    resolveRef: opts.resolveRef ?? (async () => { throw new Error("no ref"); }),
    currentDocId: opts.currentDocId,
    verbose: false,
  } as unknown as ToolCtx;
}

describe("memex__send_discord_message — handler-layer footer construction", () => {
  it("ac-8 path 1: no specRef AND no current Spec context → content only, no embed", async () => {
    tagAc(AC_8);
    const { userId, memexId } = await setup("discord-h1");

    const ctx = makeCtx(memexId, userId); // no currentDocId, no resolveRef hit
    await discordSpec.handler({ text: "plain status" }, ctx);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(WEBHOOK_URL);
    expect(captured!.body).toEqual({ content: "plain status" });
    expect(captured!.body).not.toHaveProperty("embeds");
  });

  it("ac-8 path 2: no specRef but currentDocId set → embed auto-attached from the bound Spec (dec-5)", async () => {
    tagAc(AC_8);
    const { userId, memexId, nsSlug } = await setup("discord-h2");
    const spec = await createSpec(userId, nsSlug, memexId, "Auto Footer Spec");

    const ctx = makeCtx(memexId, userId, { currentDocId: spec.id });
    await discordSpec.handler({ text: "deploy done" }, ctx);

    const expectedUrl = `${buildTenantUrl({ namespace: nsSlug, memex: "main" })}/specs/${spec.handle}`;
    expect(captured!.body).toHaveProperty("content", "deploy done");
    expect(Array.isArray(captured!.body.embeds)).toBe(true);
    expect(captured!.body.embeds).toHaveLength(1);
    expect(captured!.body.embeds[0].description).toBe(`**Spec:** [Auto Footer Spec](${expectedUrl})`);
  });

  it("ac-9 + ac-10: explicit specRef → content + 1-element embeds; description is **Spec:** [title](url) built by the handler", async () => {
    tagAc(AC_9);
    tagAc(AC_10);
    const { userId, memexId, nsSlug } = await setup("discord-h3");

    const resolveRef = async (): Promise<ResolvedRef> => ({
      doc: { title: "Discord Integration", handle: "spec-138" } as any,
      slugs: { namespace: nsSlug, memex: "main" },
      memexId,
      entity: {} as any,
    });
    const ctx = makeCtx(memexId, userId, { resolveRef });
    await discordSpec.handler(
      { text: "see the spec", specRef: `${nsSlug}/main/specs/spec-138` },
      ctx,
    );

    const expectedUrl = `${buildTenantUrl({ namespace: nsSlug, memex: "main" })}/specs/spec-138`;
    expect(captured!.body).toHaveProperty("content", "see the spec");
    expect(captured!.body.embeds).toHaveLength(1);
    expect(captured!.body.embeds[0]).toEqual({ description: `**Spec:** [Discord Integration](${expectedUrl})` });
    // no footer object — corrected from the original dec-3 plan (issue-1)
    expect(captured!.body.embeds[0]).not.toHaveProperty("footer");
  });
});
