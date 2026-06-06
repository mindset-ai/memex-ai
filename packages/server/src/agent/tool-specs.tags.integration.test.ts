// spec-136 t-4 — AC-5: tags ride the EXISTING MCP tools (no new granular tools).
//
// This file is TAGGED (tagAc → POSTs to prod memex.ai). DO NOT run it in the
// auto-mode classifier — a human runs the tagged suite later. The orchestrator
// only runs UNTAGGED files; verification of this work is via tsc + build +
// untagged route tests.
//
// What ac-5 pins:
//   - update_doc({tags}) applies tags to the Spec (create-or-pick via the tags
//     service; scoped tags are mutually exclusive within their scope).
//   - update_doc({removeTags}) drops them again.
//   - list_docs({tags}) narrows the result to Specs carrying the filter.
//   - get_doc returns the Spec's tags inline (both verbose and terse shapes).
//
// Mirrors the DB-backed setup of tool-specs.integration.test.ts (real resolver,
// real services, local Postgres). Adapted to develop: docType is 'spec' (the
// legacy doc-type rename is final) and refs use the `specs/` path segment.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  documents,
  tags as tagsTable,
  documentTags,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { NotFoundError } from "../types/errors.js";
import { toolSpecs } from "./tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { ValidationError } from "../types/errors.js";
import type { ToolCtx } from "./tool-specs.js";

const AC_5 = "mindset-prod/memex-building-itself/specs/spec-136/acs/ac-5";

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (cleanup.memexes.length) {
    await db.delete(documentTags).where(inArray(documentTags.memexId, cleanup.memexes)).catch(() => {});
    await db.delete(tagsTable).where(inArray(tagsTable.memexId, cleanup.memexes)).catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

async function slugsFor(memexId: string): Promise<{ namespace: string; memex: string }> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) throw new Error(`memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns) throw new Error(`namespace for memex ${memexId} not found`);
  return { namespace: ns.slug, memex: memex.slug };
}

function docRef(slugs: { namespace: string; memex: string }, handle: string): string {
  return `${slugs.namespace}/${slugs.memex}/specs/${handle}`;
}

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec not found: ${name}`);
  return spec;
}

function ctxFor(memexId: string, userId: string, verbose: boolean): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) throw new ValidationError(`Ref redirected: "${ref}".`);
      if ("notFound" in result) throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== memexId) throw new NotFoundError(`Ref "${ref}" not found.`);
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

describe("spec-136 t-4 ac-5: tags ride the existing MCP tools", () => {
  let memexId: string;
  let docId: string;
  let docHandle: string;
  let otherHandle: string;
  let slugs: { namespace: string; memex: string };
  // Must be a REAL user row: document_tags.added_by is an FK to users(id) on develop
  // (spec-122 attribution). A synthetic uuid violates document_tags_added_by_fkey.
  let userId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("spec136-t4-tags");
    cleanup.memexes.push(memexId);
    userId = (await upsertUserByEmail("spec136-t4@example.com")).id;
    slugs = await slugsFor(memexId);
    const doc = await createDocDraft(memexId, "Tagged Spec", "For tag tooling.", "spec");
    docId = doc.id;
    docHandle = doc.handle;
    cleanup.docs.push(doc.id);
    const other = await createDocDraft(memexId, "Untagged Spec", "No tags here.", "spec");
    otherHandle = other.handle;
    cleanup.docs.push(other.id);
    // createDocDraft starts docs in `draft`, but list_docs only surfaces ACTIVE Specs
    // (status in specify/build/verify). Activate both so the tag FILTER — not the status
    // filter — is what distinguishes them in the list_docs({tags}) assertion below.
    await db
      .update(documents)
      .set({ status: "build" })
      .where(inArray(documents.id, [doc.id, other.id]));
  });

  it("update_doc({tags}) applies tags; get_doc returns them inline; list_docs({tags}) narrows", async () => {
    tagAc(AC_5);

    const updateDoc = specByName("update_doc");
    const getDocSpec = specByName("get_doc");
    const listDocsSpec = specByName("list_docs");
    const ref = docRef(slugs, docHandle);

    // 1. Apply via the EXISTING update_doc tool — no add_tag tool exists.
    const applyOut = await updateDoc.handler(
      { ref, tags: ["priority::high", "bug"] },
      ctxFor(memexId, userId, false),
    );
    expect(applyOut).toMatch(/priority::high/);
    expect(applyOut).toMatch(/bug/);

    // The bridge actually carries both tags.
    const linked = await db
      .select({ scope: tagsTable.scope, value: tagsTable.value })
      .from(documentTags)
      .innerJoin(tagsTable, eq(tagsTable.id, documentTags.tagId))
      .where(eq(documentTags.docId, docId));
    const linkedStrings = linked.map((t) => (t.scope === null ? t.value : `${t.scope}::${t.value}`));
    expect(linkedStrings).toContain("priority::high");
    expect(linkedStrings).toContain("bug");

    // 2. get_doc returns tags inline — terse shape.
    const terse = await getDocSpec.handler({ ref }, ctxFor(memexId, userId, false));
    expect(terse).toMatch(/Tags:/);
    expect(terse).toMatch(/priority::high/);
    expect(terse).toMatch(/bug/);

    // get_doc verbose shape also carries the tag strip.
    const verbose = await getDocSpec.handler({ ref }, ctxFor(memexId, userId, true));
    expect(verbose).toMatch(/Tags:/);
    expect(verbose).toMatch(/priority::high/);

    // 3. Scoped mutual exclusivity: applying priority::low displaces priority::high.
    await updateDoc.handler({ ref, tags: ["priority::low"] }, ctxFor(memexId, userId, false));
    const afterSwap = await getDocSpec.handler({ ref }, ctxFor(memexId, userId, false));
    expect(afterSwap).toMatch(/priority::low/);
    expect(afterSwap).not.toMatch(/priority::high/);
    expect(afterSwap).toMatch(/bug/); // flat tag untouched

    // 4. list_docs({tags}) narrows to the tagged Spec.
    const filtered = await listDocsSpec.handler(
      { tags: ["priority::low"], docType: "spec", verbose: true },
      ctxFor(memexId, userId, true),
    );
    expect(filtered).toMatch(new RegExp(docHandle));
    expect(filtered).not.toMatch(new RegExp(otherHandle));

    // A filter on an absent tag returns no Specs.
    const empty = await listDocsSpec.handler(
      { tags: ["priority::nonexistent"], docType: "spec", verbose: true },
      ctxFor(memexId, userId, true),
    );
    expect(empty).not.toMatch(new RegExp(docHandle));

    // 5. removeTags drops the tag again.
    const removeOut = await updateDoc.handler(
      { ref, removeTags: ["bug"] },
      ctxFor(memexId, userId, false),
    );
    expect(removeOut).toMatch(/removed bug/);
    const afterRemove = await getDocSpec.handler({ ref }, ctxFor(memexId, userId, false));
    expect(afterRemove).not.toMatch(/\bbug\b/);
    expect(afterRemove).toMatch(/priority::low/);
  });

  it("no new granular tag tools exist (std-16): tags ride existing tools only", () => {
    tagAc(AC_5);
    const names = toolSpecs.map((s) => s.name);
    expect(names).not.toContain("add_tag");
    expect(names).not.toContain("remove_tag");
    expect(names).not.toContain("list_tags");
    // update_doc carries the tag args; list_docs carries the filter arg.
    const updateDoc = specByName("update_doc");
    expect(Object.keys(updateDoc.schema)).toEqual(expect.arrayContaining(["tags", "removeTags"]));
    const listDocsSpec = specByName("list_docs");
    expect(Object.keys(listDocsSpec.schema)).toEqual(expect.arrayContaining(["tags"]));
  });
});
