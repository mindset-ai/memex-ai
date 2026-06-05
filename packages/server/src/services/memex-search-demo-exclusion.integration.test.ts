// Handhold demo specs are invisible AND inert to ⌘K / MCP search, to the MCP +
// agent enumeration, and to the MCP + agent read/act path (spec-178 t-11 /
// dec-11). This is the EXCLUDE posture that reverses the earlier "searchable"
// stance (ac-20, flipped in activity-log-demo-exclusion.integration.test.ts).
//
// All four guarantees run against REAL Postgres (no mocks):
//
//   ac-36 (search): searchMemex() omits an is_demo spec on every arm. Here we
//     prove the FTS content arm and the exact-handle short-circuit both miss it.
//     The board does NOT use searchMemex, so the exclusion is unconditional —
//     there is no opt-in flag to assert.
//
//   ac-37 (enumeration): listDocs(memexId, { excludeDemo: true }) — the MCP /
//     agent `list_docs` path — omits the demo spec, while the plain
//     listDocs(memexId) the REST board uses STILL includes it (no board
//     regression). The same case also proves the MCP doc-resolution chokepoint
//     (resolveRefForUser) treats an is_demo spec as not-found (std-7), so a
//     coding agent can neither read (get_doc) nor mutate against it.
//
//   ac-38 (in-app agents): an agent cannot DISCOVER or ACT on a demo spec — every
//     autonomous doc path (search / enumeration / ref-resolution via
//     resolveRefForAgent) excludes it. This case drives the ref-resolution arm:
//     get_doc against a demo spec's ref returns not-found. (Documented carve-out per
//     ac-38: the chat agent MAY read the ONE demo spec the user has explicitly opened
//     as bound current-doc context — buildDocumentContext → getDoc — which is the
//     intended exception, not an exclusion path, and is not exercised here.)
//
// Cleanup deletes doc_sections + documents for our memexes, then the namespaces
// (cascading to org/memex/memberships).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { docSections, documents, memexes, namespaces } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft, listDocs } from "./documents.js";
import { addSection } from "./sections.js";
import { embedAndStoreDoc } from "./memex-embeddings.js";
import { searchMemex } from "./memex-search.js";
import { resolveRefForUser } from "../mcp/tools.js";
import { executeServerTool } from "../agent/tools.js";
import { NotFoundError } from "../types/errors.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-178/acs/ac-${n}`;

const createdMemexIds: string[] = [];
let memexId: string;
let nsSlug: string;
let devUserId: string;

// Deterministic provider so the vector arm never calls a real embedding API.
function makeFakeProvider(name = "fake-demo-excl-1536"): EmbeddingProvider {
  return {
    name,
    dim: 1536,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const seed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return Array.from({ length: 1536 }, (_, i) => ((seed + i) % 100) / 100);
      });
    },
  };
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("demoexcl");
  memexId = made.memexId;
  nsSlug = made.slug;
  createdMemexIds.push(memexId);
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
});

afterAll(async () => {
  const docRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(inArray(documents.memexId, createdMemexIds))
    .catch(() => [] as { id: string }[]);
  const docIds = docRows.map((r) => r.id);
  if (docIds.length) {
    await db.delete(docSections).where(inArray(docSections.docId, docIds)).catch(() => {});
  }
  await db.delete(documents).where(inArray(documents.memexId, createdMemexIds)).catch(() => {});
  const memexRows = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(inArray(memexes.id, createdMemexIds))
    .catch(() => [] as { namespaceId: string }[]);
  await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  const namespaceIds = memexRows.map((r) => r.namespaceId);
  if (namespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds)).catch(() => {});
  }
});

describe("handhold demo exclusion — search (ac-36)", () => {
  it("searchMemex omits an is_demo spec on the FTS and handle arms", async () => {
    tagAc(AC(36));

    const provider = makeFakeProvider();
    const token = "handholddemoexcludexyztoken";
    const spec = await createDocDraft(
      memexId,
      "Demo spec for search exclusion",
      `This demo overview mentions ${token} so FTS could find it.`,
      "spec",
    );
    await addSection(memexId, spec.id, "scope", `In scope: ${token} coverage.`);
    await db.update(documents).set({ isDemo: true }).where(eq(documents.id, spec.id));
    await embedAndStoreDoc(spec.id, { provider });

    // FTS content arm — would surface the doc on its unique token if it weren't demo.
    const ftsHits = await searchMemex(memexId, token, { provider, disableVector: true });
    expect(ftsHits.find((h) => h.id === spec.id)).toBeUndefined();

    // Exact-handle short-circuit — also misses a demo spec.
    const handleHits = await searchMemex(memexId, spec.handle, { provider });
    expect(handleHits.find((h) => h.id === spec.id)).toBeUndefined();
  });
});

describe("handhold demo exclusion — enumeration + read/act (ac-37)", () => {
  it("MCP list path omits a demo spec; plain board listDocs still includes it; MCP resolver 404s it", async () => {
    tagAc(AC(37));

    // A demo spec + an ordinary spec, both in plan so the agent list's
    // statusIn:['plan','build','verify'] surfaces the non-demo one.
    const demo = await createDocDraft(memexId, "Demo spec enum", "Demo overview.", "spec");
    const real = await createDocDraft(memexId, "Real spec enum", "Real overview.", "spec");
    await db.update(documents).set({ isDemo: true, status: "plan" }).where(eq(documents.id, demo.id));
    await db.update(documents).set({ status: "plan" }).where(eq(documents.id, real.id));

    // MCP / agent enumeration: excludeDemo:true (+ the agent list's status scope)
    // drops the demo spec but keeps the real one.
    const agentList = await listDocs(memexId, {
      docType: "spec",
      includePaused: false,
      statusIn: ["plan", "build", "verify"],
      excludeDemo: true,
    });
    const agentIds = agentList.map((d) => d.id);
    expect(agentIds).not.toContain(demo.id);
    expect(agentIds).toContain(real.id);

    // REST board enumeration: NO excludeDemo → the demo spec is STILL listed
    // (the board renders it with a DEMO badge). No regression.
    const boardList = await listDocs(memexId, "spec");
    const boardIds = boardList.map((d) => d.id);
    expect(boardIds).toContain(demo.id);
    expect(boardIds).toContain(real.id);
    // ...and the demo flag rides on the board summary so the badge can render.
    expect(boardList.find((d) => d.id === demo.id)?.isDemo).toBe(true);

    // MCP doc-resolution chokepoint: resolving the demo spec's ref is not-found
    // (std-7), so get_doc / mutating tools can't read or act on it.
    const demoRow = boardList.find((d) => d.id === demo.id)!;
    const demoRef = `${nsSlug}/main/specs/${demoRow.handle}`;
    await expect(resolveRefForUser(devUserId, demoRef, undefined)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Control: the real spec's ref STILL resolves through the same chokepoint.
    const realRow = boardList.find((d) => d.id === real.id)!;
    const realRef = `${nsSlug}/main/specs/${realRow.handle}`;
    const resolved = await resolveRefForUser(devUserId, realRef, undefined);
    expect(resolved.doc.id).toBe(real.id);
  });
});

describe("handhold demo exclusion — in-app agent read path (ac-38)", () => {
  it("the agent get_doc tool treats a demo spec as not-found", async () => {
    tagAc(AC(38));

    const demo = await createDocDraft(memexId, "Demo spec agent read", "Demo overview.", "spec");
    const real = await createDocDraft(memexId, "Real spec agent read", "Real overview.", "spec");
    await db.update(documents).set({ isDemo: true }).where(eq(documents.id, demo.id));

    const slugs = { ns: nsSlug, mx: "main" };
    const demoRef = `${slugs.ns}/${slugs.mx}/specs/${demo.handle}`;
    const realRef = `${slugs.ns}/${slugs.mx}/specs/${real.handle}`;

    // The React/LangGraph agent and the server Anthropic-SDK agent both run
    // get_doc through executeServerTool → buildAgentCtx → resolveRefForAgent.
    await expect(
      executeServerTool(memexId, "get_doc", { ref: demoRef }, devUserId),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Control: the non-demo spec is readable through the very same path.
    const out = await executeServerTool(memexId, "get_doc", { ref: realRef }, devUserId);
    expect(out).toContain(real.handle);
  });
});
