// spec-156 ac-19 — update_doc's tag writes derive their channel from the
// invoking context (mcp vs in_app_agent), not the hardcoded "mcp" that used to
// sit at tool-specs.ts:1184. Pulse must attribute agent-driven tagging to the
// in_app_agent channel; MCP-driven tagging stays 'mcp'.
//
// The tag write routes through applyTagString → mutate(), which stamps
// ctx.channel onto the emitted ChangeEvent. So we drive update_doc with a
// ToolCtx whose `channel` varies and assert the bus event's `channel` follows.
//
// This file is TAGGED (tagAc → POSTs AC events to the prod memex). Run with
// MEMEX_EMIT=false to suppress those posts in local/CI runs.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { NotFoundError, ValidationError } from "../types/errors.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";

const AC_19 = "mindset-prod/memex-building-itself/specs/spec-156/acs/ac-19";

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

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec not found: ${name}`);
  return spec;
}

// Builds a ToolCtx with an explicit `channel` so we can prove the tag-write
// channel follows the invoking surface. `channel: undefined` exercises the
// `?? "mcp"` default that keeps MCP behaviour for ctxes that never set it.
function ctxFor(
  memexId: string,
  userId: string,
  channel: ToolCtx["channel"],
): ToolCtx {
  return {
    userId,
    channel,
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
    workspaceUrl: async () => "",
    verbose: false,
  };
}

describe("spec-156 ac-19: update_doc tag-write channel follows the invoking context", () => {
  let memexId: string;
  let userId: string;
  let ref: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("spec156-ac19");
    cleanup.memexes.push(memexId);
    // document_tags.added_by is an FK to users(id); use a real row.
    userId = (await upsertUserByEmail("spec156-ac19@example.com")).id;
    const slugs = await slugsFor(memexId);
    const doc = await createDocDraft(memexId, "Channel Spec", "Tag-channel attribution.", "spec");
    cleanup.docs.push(doc.id);
    await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
    ref = `${slugs.namespace}/${slugs.memex}/specs/${doc.handle}`;
  });

  beforeEach(() => bus._reset());

  // Capture only the document.updated event the tag write emits via mutate().
  function captureTagEvents(): ChangeEvent[] {
    const received: ChangeEvent[] = [];
    bus.subscribe({ memexId, entity: "document", actions: ["updated"] }, (e) => received.push(e));
    return received;
  }

  it("in_app_agent ctx → tag write emits channel 'in_app_agent'", async () => {
    tagAc(AC_19);
    const received = captureTagEvents();
    await specByName("update_doc").handler(
      { ref, tags: ["agentwrote"] },
      ctxFor(memexId, userId, "in_app_agent"),
    );
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.every((e) => e.channel === "in_app_agent")).toBe(true);
  });

  it("mcp ctx → tag write emits channel 'mcp'", async () => {
    tagAc(AC_19);
    const received = captureTagEvents();
    await specByName("update_doc").handler(
      { ref, tags: ["mcpwrote"] },
      ctxFor(memexId, userId, "mcp"),
    );
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.every((e) => e.channel === "mcp")).toBe(true);
  });

  it("ctx with no channel set → defaults to 'mcp' (preserves the historic MCP behaviour)", async () => {
    tagAc(AC_19);
    const received = captureTagEvents();
    await specByName("update_doc").handler(
      { ref, removeTags: ["mcpwrote"] },
      ctxFor(memexId, userId, undefined),
    );
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.every((e) => e.channel === "mcp")).toBe(true);
  });
});
