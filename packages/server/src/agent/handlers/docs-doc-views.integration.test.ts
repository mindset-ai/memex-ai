// spec-448 t-5 — MCP-surface stamping of the per-user "last-seen version"
// marker (doc_views).
//
// ac-8:  the marker advances on the caller's OWN mcp writes.
// ac-37: a mutating doc handler (update_doc / create_doc) stamps
//        upsertDocView(channel='mcp'); the read handler (get_doc) must NOT.
//
// Invokes the tool handlers directly (bypassing the MCP transport), mirroring
// agent/handlers/facets.integration.test.ts's pattern of a hand-rolled ToolCtx
// against a real Postgres.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { documents, docViews, users } from "../../db/schema.js";
import type { Doc } from "../../db/schema.js";
import { makeTestMemex } from "../../services/test-helpers.js";
import { upsertUserByEmail } from "../../services/users.js";
import { createDocDraft } from "../../services/documents.js";
import { memexSlugsById } from "../../mcp/refs.js";
import { docsTools } from "./docs.js";
import type { ResolvedRef, ToolCtx } from "./shared.js";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-8";
const AC_37 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-37";

const runId = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const updateDocTool = docsTools.find((t) => t.name === "update_doc")!;
const getDocTool = docsTools.find((t) => t.name === "get_doc")!;
const createDocTool = docsTools.find((t) => t.name === "create_doc")!;

let memexId: string;
let docId: string;
let slugs: { namespace: string; memex: string };
let mutatorUserId: string;
let readerUserId: string;
const createdUserIds: string[] = [];

async function loadDoc(): Promise<Doc> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
  if (!doc) throw new Error("test doc vanished");
  return doc;
}

// A minimal ResolvedRef for the seeded doc — the handlers under test only read
// entity/memexId/doc/slugs off it (resolveRefArg is just `ctx.resolveRef(ref)`).
async function resolvedDocRef(): Promise<ResolvedRef> {
  const doc = await loadDoc();
  return {
    entity: { kind: "doc", row: doc },
    memexId,
    doc,
    slugs,
  };
}

function makeCtx(userId: string, overrides: Partial<ToolCtx> = {}): ToolCtx {
  return {
    userId,
    channel: "mcp",
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async () => resolvedDocRef(),
    workspaceUrl: async () => "",
    verbose: false,
    ...overrides,
  };
}

beforeAll(async () => {
  memexId = await makeTestMemex(`dv-mcp-${runId}`);
  const doc = await createDocDraft(memexId, `docViews MCP test spec ${runId}`, "Purpose", "spec");
  docId = doc.id;
  const s = await memexSlugsById(memexId);
  if (!s) throw new Error("memexSlugsById returned null for a just-created memex");
  slugs = s;

  const mutator = await upsertUserByEmail(`dv-mcp-mutator-${runId}@example.com`);
  const reader = await upsertUserByEmail(`dv-mcp-reader-${runId}@example.com`);
  mutatorUserId = mutator.id;
  readerUserId = reader.id;
  createdUserIds.push(mutatorUserId, readerUserId);
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("spec-448 t-5: MCP doc handlers stamp doc_views (ac-8, ac-37)", () => {
  it("ac-37: get_doc (a read) does NOT create a doc_views row for the caller", async () => {
    tagAc(AC_37);

    const before = await db.select().from(docViews).where(eq(docViews.userId, readerUserId));
    expect(before).toHaveLength(0);

    const ctx = makeCtx(readerUserId);
    const out = await getDocTool.handler({ ref: "unused-stub-ref" }, ctx);
    expect(typeof out).toBe("string");

    const after = await db.select().from(docViews).where(eq(docViews.userId, readerUserId));
    expect(after).toHaveLength(0);
  });

  it("ac-8 / ac-37: update_doc (a mutation) stamps upsertDocView(channel='mcp') for the caller", async () => {
    tagAc(AC_8);
    tagAc(AC_37);

    const doc = await loadDoc();
    const ctx = makeCtx(mutatorUserId);
    const out = await updateDocTool.handler({ ref: "unused-stub-ref", title: "Renamed via MCP test" }, ctx);
    expect(typeof out).toBe("string");

    const rows = await db.select().from(docViews).where(eq(docViews.userId, mutatorUserId));
    expect(rows).toHaveLength(1);
    expect(rows[0].docId).toBe(docId);
    expect(rows[0].lastViewedVersion).toBe(doc.version);
    expect(rows[0].channel).toBe("mcp");
  });

  it("create_doc (a mutation) also stamps the creator's marker on the freshly created doc", async () => {
    tagAc(AC_8);

    const ctx = makeCtx(mutatorUserId, {
      resolveMemex: async () => memexId,
    });
    const out = (await createDocTool.handler(
      { memex: undefined, title: `docViews create_doc test ${runId}`, purpose: "Purpose" },
      ctx,
    )) as string;
    expect(out).toContain("Spec created");

    const created = await db.query.documents.findFirst({
      where: eq(documents.title, `docViews create_doc test ${runId}`),
    });
    expect(created).toBeDefined();

    const rows = await db.select().from(docViews).where(eq(docViews.docId, created!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(mutatorUserId);
    expect(rows[0].channel).toBe("mcp");
    expect(rows[0].lastViewedVersion).toBe(created!.version);

    await db.delete(documents).where(eq(documents.id, created!.id)).catch(() => {});
  });
});
