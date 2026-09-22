// spec-510 t-10 (dec-1, dec-5 — ac-22): the cadence key, one resolver per surface.
//
// WHY THIS EXISTS. spec-510's cadence keys its per-session seen-set on an
// identifier. The MCP surface has one — `ctx.sessionId`, the `Mcp-Session-Id`
// the dispatch layer threads in. The in-app React agent HAS NONE: `buildAgentCtx`
// never set one, and `tool-contract.ts` says so in its own words — "Present only
// on the MCP surface; undefined for the in-app agent". Without a key the in-app
// agent falls back to "emit in full" forever, so ~a fifth of the Spec's promise
// (ac-4, both surfaces) is unbuildable.
//
// WHY A LAZY RESOLVER RATHER THAN A FIELD. The in-app key is a DB lookup
// (`conversations` by doc + user). Resolving it eagerly in `buildAgentCtx` would
// put a query on the hot path of EVERY in-app tool call, most of which never
// reach a Spec footer. `ToolCtx` already has this exact pattern —
// `getOrgBlocksForNudge`, whose comment reads "Lazy — only invoked when a handler
// reaches a spec doc state formatter… we don't pay the lookup cost up front."
// This follows it.
//
// WHY ONE RESOLVER AND NOT A SECOND PLAIN FIELD. t-10 framed the choice as
// "reuse ctx.sessionId, or add ctx.threadId". Both are worse: reusing sessionId
// forces the eager lookup above, and a second field means every consumer must
// know which to read. One thunk gives the seat a single thing to call, with no
// branching on surface.
//
// ⚠ THE TWO SURFACES DO NOT MEAN THE SAME THING BY "SESSION", and that is a real
// consequence, not a detail. An MCP session spans every Spec an agent touches in
// a working session. An in-app conversation is per (doc, user). So "shown once
// per session" means once across ALL your work on MCP, and once PER SPEC in-app:
// an agent moving between three Specs sees the guidance three times in the web
// app and once over MCP. ac-4 committed to "each keyed to its own session or
// thread", so this is within what was promised — but it means the two surfaces
// get materially different suppression rates, which matters when t-9 reads the
// dogfood numbers.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  users,
  conversations,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  conversationCadenceKey,
  getOrCreateConversation,
} from "./conversations.js";
import { mcpCadenceKey } from "../agent/handlers/tool-contract.js";

const AC_22 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-22";

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(conversations).where(inArray(conversations.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("cadence-key");
});

async function freshSpec(title: string): Promise<string> {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  return doc.id;
}

describe("the MCP surface yields its session id (ac-22)", () => {
  it("resolves to the Mcp-Session-Id it was built with", async () => {
    tagAc(AC_22);
    expect(await mcpCadenceKey("sess-abc")()).toBe("sess-abc");
  });

  it("yields undefined when the dispatch layer had no session (stateless / test paths)", async () => {
    tagAc(AC_22);
    // `createMcpServer`'s sessionId param is optional; this is exactly when the
    // footer already falls back to the compressed essence today.
    expect(await mcpCadenceKey(undefined)()).toBeUndefined();
  });
});

describe("the in-app surface yields its conversation id (ac-22)", () => {
  it("resolves the conversation for this (doc, user)", async () => {
    tagAc(AC_22);
    const docId = await freshSpec("Cadence key — bound chat");
    const convo = await getOrCreateConversation(actor.memexId, docId, actor.user.id);

    expect(await conversationCadenceKey(docId, actor.user.id)).toBe(convo.id);
  });

  it("is PER (doc, user) — a second Spec is a different thread", async () => {
    tagAc(AC_22);
    // This is the asymmetry called out at the top of the file: an MCP session
    // spans Specs, an in-app conversation does not.
    const docA = await freshSpec("Cadence key — Spec A");
    const docB = await freshSpec("Cadence key — Spec B");
    const a = await getOrCreateConversation(actor.memexId, docA, actor.user.id);
    const b = await getOrCreateConversation(actor.memexId, docB, actor.user.id);

    expect(a.id).not.toBe(b.id);
    expect(await conversationCadenceKey(docA, actor.user.id)).toBe(a.id);
    expect(await conversationCadenceKey(docB, actor.user.id)).toBe(b.id);
  });

  it("yields undefined BEFORE the conversation row exists — the common first call", async () => {
    tagAc(AC_22);
    // Every conversation starts here: the user opens a Spec and the agent runs a
    // tool before any message has been persisted. The resolver must not invent a
    // key; the documented fallback is to emit guidance in full.
    const docId = await freshSpec("Cadence key — no conversation yet");
    expect(await conversationCadenceKey(docId, actor.user.id)).toBeUndefined();
  });

  it("yields undefined when the chat is not bound to a document", async () => {
    tagAc(AC_22);
    // `currentDocId` is optional on executeServerTool — an unbound chat has no
    // conversation and therefore no key.
    expect(await conversationCadenceKey(undefined, actor.user.id)).toBeUndefined();
  });

  it("yields undefined rather than throwing when the lookup fails — and says so in the log", async () => {
    tagAc(AC_22);
    // A malformed id must not take down a tool turn: guidance cadence is
    // advisory, and the fallback (emit in full) is the pre-Spec behaviour.
    //
    // ⚠ THIS TEST USED TO ASSERT ONLY THE `undefined` (PR #740 round-5, M-16).
    // "not-a-uuid" into a uuid column raises Postgres 22P02, which
    // `conversationIdFor` catches — so the test was green BECAUSE of a swallow
    // while its comment claimed the failure was handled. Those two states look
    // identical from here, and the difference is the whole point: a PERSISTENT
    // lookup failure returns undefined forever, the in-app cadence silently
    // never applies, and ac-4's "both surfaces" quietly becomes one.
    //
    // Asserting the log is what separates handled from hidden.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await conversationCadenceKey("not-a-uuid", actor.user.id)).toBeUndefined();
      const logged = (errorSpy.mock.calls as unknown[][]).some((args) =>
        args.some((a) => a instanceof Error),
      );
      expect(
        logged,
        "The failed lookup was swallowed without a word. That is the only " +
          "signal that the in-app surface has stopped getting a cadence key — " +
          "the tool turn still succeeds and the response still looks correct.",
      ).toBe(true);
    } finally {
      // Restore, never clear [per std-37] — a leaked console stub silences every
      // suite that runs after this one in the same worker.
      errorSpy.mockRestore();
    }
  });
});
