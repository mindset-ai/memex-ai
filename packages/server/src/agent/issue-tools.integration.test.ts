// spec-112 t-5 — MCP/agent Issue tools: register/list/get/update/resolve/search.
//
// These tools mirror+extend the acs/tasks/decisions catalogue (no new infra,
// s-4). The handlers are exercised through a hand-rolled agent ToolCtx (the same
// `buildAgentCtx` contract `executeServerTool` offers) so the assertions land on
// observable behaviour, not adapter glue.
//
// AC emission: every test that proves an AC calls tagAc('<full canonical ref>').

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, issues, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft, updateDocStatus, archiveDoc } from "../services/documents.js";
import { embedAndStoreDoc } from "../services/memex-embeddings.js";
import { createIssue } from "../services/issues.js";
import { toolSpecs } from "./tool-specs.js";
import { suggestActiveSpecsForIssue } from "./tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { toolManifest } from "@memex/shared";
import type { ToolCtx } from "./tool-specs.js";
import type { EmbeddingProvider } from "../services/embedding-provider.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const createdDocIds: string[] = [];
const createdMemexIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// A topic-aware fake embedding provider (same approach as
// memex-search.integration.test.ts) so the vector arm is deterministic and the
// ac-27 vector-path ranking is exercised offline.
function makeFakeProvider(name = "fake-issue-1536"): EmbeddingProvider {
  return {
    name,
    dim: 1536,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const baseSeed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const vec = Array.from({ length: 1536 }, (_, i) => ((baseSeed + i) % 100) / 100);
        const lower = t.toLowerCase();
        const topics = [
          { word: "login", dim: 0 },
          { word: "payment", dim: 1 },
          { word: "search", dim: 2 },
          { word: "auth", dim: 3 },
        ];
        for (const topic of topics) {
          if (lower.includes(topic.word)) vec[topic.dim] = 1;
        }
        return vec;
      });
    },
  };
}

let memexId: string;
let USER: string;
beforeAll(async () => {
  memexId = await makeTestMemex("issuetools");
  createdMemexIds.push(memexId);
  // A real user row — promote_to_spec → createDocDraft sets created_by_user_id,
  // which carries an FK to users (unlike issues.created_by_user_id).
  const user = await upsertUserByEmail(`issuetools-${Date.now()}@test.example`);
  USER = user.id;
});

async function slugsFor(id: string): Promise<{ namespace: string; memex: string }> {
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, id) });
  if (!mx) throw new Error(`memex ${id} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, mx.namespaceId) });
  if (!ns) throw new Error(`ns for ${id} not found`);
  return { namespace: ns.slug, memex: mx.slug };
}

async function makeSpec(title: string, status?: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, `${title} overview`, "spec");
  createdDocIds.push(doc.id);
  if (status && status !== "draft") {
    await updateDocStatus(memexId, doc.id, status);
  }
  return { id: doc.id, handle: doc.handle };
}

// Hand-rolled agent ctx mirroring buildAgentCtx (see tool-specs.integration.test.ts).
function ctxFor(boundMemex: string, userId: string, verbose: boolean): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => boundMemex,
    resolveMemex: async () => boundMemex,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(`Ref redirected: "${ref}" → "${result.newRef}".`);
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== boundMemex) {
        throw new NotFoundError(`Ref "${ref}" not found.`);
      }
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
      };
    },
    workspaceUrl: async () => (verbose ? "https://test.example" : ""),
    verbose,
  };
}

function spec(name: string) {
  const s = toolSpecs.find((t) => t.name === name);
  if (!s) throw new Error(`tool spec ${name} not found`);
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// ac-14 — search_issues present in BOTH the @memex/shared manifest and the live
// catalogue, and returns cross-spec Issue matches.
// ──────────────────────────────────────────────────────────────────────────
describe("search_issues — manifest+catalogue presence and cross-spec matches (ac-14)", () => {
  it("is registered in the @memex/shared manifest and the live tool-specs catalogue", () => {
    tagAc(AC(14));
    // The manifest↔catalogue parity (regression test) already enforces the two
    // are in lockstep; here we pin search_issues on BOTH directly.
    expect(toolManifest.map((e) => e.name)).toContain("search_issues");
    expect(toolSpecs.map((s) => s.name)).toContain("search_issues");
  });

  it("returns cross-spec Issue matches — an issue on one Spec is found from another", async () => {
    tagAc(AC(14));
    const specA = await makeSpec("Search Issues Spec A");
    const specB = await makeSpec("Search Issues Spec B");
    // A distinctive token so FTS matches deterministically without a provider.
    await createIssue({
      memexId,
      docId: specA.id,
      title: "Zorptacular crash on export",
      body: "The zorptacular subsystem panics",
      type: "bug",
    });
    await createIssue({
      memexId,
      docId: specB.id,
      title: "Unrelated todo",
      body: "tidy the kitchen",
      type: "todo",
    });

    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("search_issues").handler({ query: "zorptacular" }, ctx);
    // The cross-spec match is discoverable; the unrelated issue is not.
    expect(out).toContain("/issues/issue-");
    expect(out.toLowerCase()).toContain("zorptacular");
    expect(out).not.toContain("Unrelated todo");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-25 / ac-26 — register_issue with NO Spec ref persists nothing and returns
// the two-option assist (no silent default home, std-5).
// ──────────────────────────────────────────────────────────────────────────
describe("register_issue without a Spec — homeless assist, persists nothing (ac-25, ac-26)", () => {
  it("persists no Issue row and returns the two-option assist", async () => {
    tagAc(AC(26));
    tagAc(AC(25));
    const before = await db.select().from(issues);
    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("register_issue").handler(
      { title: "Homeless bug", body: "no spec was named", type: "bug" },
      ctx,
    );
    const after = await db.select().from(issues);

    // No Issue persisted (homeless issue never lands — ac-25).
    expect(after.length).toBe(before.length);

    // The response is the two-option assist (ac-26): promote, or pick an active Spec.
    expect(out).toContain("promote_to_spec: true");
    expect(out.toLowerCase()).toContain("best-suited active spec");
    // No silent default home — the response makes clear nothing was created.
    expect(out.toLowerCase()).toContain("nothing was created");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-27 — best-Spec suggestion ranks via the vector path and excludes
// done/archived Specs.
// ──────────────────────────────────────────────────────────────────────────
describe("best-Spec suggestion — vector ranking, excludes done/archived (ac-27)", () => {
  it("ranks active Specs via the vector path and drops done + archived Specs", async () => {
    tagAc(AC(27));
    const provider = makeFakeProvider();

    // Two active Specs (a strong topical match + a weak one) and two that MUST be
    // excluded: one `done`, one archived — both with the strong topical match.
    const active = await makeSpec("Login authentication redesign", "specify");
    const weak = await makeSpec("Kitchen tidy backlog", "specify");
    const doneSpec = await makeSpec("Login flow legacy (closed)", "done");
    const archived = await makeSpec("Login archived effort");
    await archiveDoc(memexId, archived.id);

    // Embed every Spec so the vector arm has rows to rank.
    for (const s of [active, weak, doneSpec, archived]) {
      await embedAndStoreDoc(s.id, { provider });
    }

    const hits = await suggestActiveSpecsForIssue(
      memexId,
      "Login button does nothing",
      "Clicking the login auth button is broken",
      provider,
      10,
    );
    const handles = hits.map((h) => h.path);

    // The active topical match is suggested...
    expect(handles.some((p) => p.endsWith(`/specs/${active.handle}`))).toBe(true);
    // ...and the done + archived Specs are NEVER suggested even though they match
    // the issue text strongly (ac-27).
    expect(handles.some((p) => p.endsWith(`/specs/${doneSpec.handle}`))).toBe(false);
    expect(handles.some((p) => p.endsWith(`/specs/${archived.handle}`))).toBe(false);
    // Every returned hit is an active-phase Spec (status neither done nor archived).
    for (const h of hits) {
      expect(h.status).not.toBe("done");
      expect(h.status).not.toBe("archived");
    }
    // Ranking came through the vector arm (strategies include "vector").
    const activeHit = hits.find((h) => h.path.endsWith(`/specs/${active.handle}`));
    expect(activeHit?.strategies).toContain("vector");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-28 — 'turn into Spec' → root Spec, no orphan; 'choose Spec' → issue with
// doc_id; in both branches the resulting Issue (if any) has a non-null doc_id.
// ──────────────────────────────────────────────────────────────────────────
describe("register_issue resolution branches — promote vs choose (ac-28)", () => {
  it("'turn into a Spec' creates a root Spec (parent_doc_id NULL) and leaves no orphan Issue", async () => {
    tagAc(AC(28));
    const before = await db.select().from(issues);
    const ctx = ctxFor(memexId, USER, true);
    const out = await spec("register_issue").handler(
      {
        title: "Payment retries are flaky",
        body: "Add idempotent retry to the payment path",
        type: "bug",
        promote_to_spec: true,
      },
      ctx,
    );
    const after = await db.select().from(issues);

    // No Issue row was created — the issue became the Spec (no orphan).
    expect(after.length).toBe(before.length);

    // A new root Spec was created with parent_doc_id NULL.
    expect(out).toContain("/specs/");
    const handleMatch = out.match(/\/specs\/(spec-\d+)/);
    expect(handleMatch).not.toBeNull();
    const newSpec = await db.query.documents.findFirst({
      where: eq(documents.handle, handleMatch![1]),
    });
    expect(newSpec).toBeTruthy();
    createdDocIds.push(newSpec!.id);
    expect(newSpec!.parentDocId).toBeNull();
    expect(newSpec!.docType).toBe("spec");
  });

  it("'choose a Spec' creates the Issue with doc_id set to the chosen Spec (non-null)", async () => {
    tagAc(AC(28));
    const chosen = await makeSpec("Chosen Home Spec");
    const slugs = await slugsFor(memexId);
    const specRef = `${slugs.namespace}/${slugs.memex}/specs/${chosen.handle}`;

    const ctx = ctxFor(memexId, USER, false);
    const out = await spec("register_issue").handler(
      {
        spec_ref: specRef,
        title: "Search returns stale results",
        body: "Index lags behind writes",
        type: "bug",
      },
      ctx,
    );
    // Terse ref line points at the new issue under the chosen Spec.
    expect(out).toContain(`/specs/${chosen.handle}/issues/issue-`);

    // The persisted Issue has a non-null doc_id == the chosen Spec.
    const rows = await db.select().from(issues).where(eq(issues.docId, chosen.id));
    expect(rows.length).toBe(1);
    expect(rows[0].docId).toBe(chosen.id);
    expect(rows[0].docId).not.toBeNull();
    expect(rows[0].title).toBe("Search returns stale results");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// list / get / update / resolve round-trip (surface sanity for t-5).
// ──────────────────────────────────────────────────────────────────────────
describe("list_issues / get_issue / update_issue / resolve_issue round-trip", () => {
  it("registers, lists, gets, updates and resolves an Issue via the tool surface", async () => {
    const home = await makeSpec("Round Trip Spec");
    const slugs = await slugsFor(memexId);
    const specRef = `${slugs.namespace}/${slugs.memex}/specs/${home.handle}`;
    const ctx = ctxFor(memexId, USER, false);

    const reg = await spec("register_issue").handler(
      { spec_ref: specRef, title: "Roundtrip bug", body: "details", type: "bug", severity: "high" },
      ctx,
    );
    const issueRef = reg.match(/ref: (\S+\/issues\/issue-\d+)/)![1];

    const list = await spec("list_issues").handler({ ref: specRef }, ctx);
    expect(list).toContain(issueRef);
    expect(list).toContain("Roundtrip bug");

    const got = await spec("get_issue").handler({ ref: issueRef }, ctxFor(memexId, USER, true));
    expect(got).toContain("Roundtrip bug");
    expect(got).toContain("details");

    const upd = await spec("update_issue").handler(
      { ref: issueRef, severity: "critical" },
      ctx,
    );
    expect(upd).toContain("critical");

    const res = await spec("resolve_issue").handler(
      { ref: issueRef, resolution: "wont_fix" },
      ctx,
    );
    expect(res).toContain("wont_fix");
  });
});
