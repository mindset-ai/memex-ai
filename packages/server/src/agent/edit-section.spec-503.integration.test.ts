// spec-503: edit_section end-to-end through the ToolSpec handler against a live
// DB. Covers the guard paths (nothing written on any failure), the standards
// clause-grain gate, the terse/verbose payloads, actor stamping via the
// updateSection service, and the surface wiring (one catalogue, both surfaces,
// absent from every scoped mode).
import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  documents,
  docSections,
  standardClauses,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createStandard } from "../services/standards.js";
import { addSection } from "../services/sections.js";
import { ValidationError } from "../types/errors.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";
import { getToolDefinitions, isToolAllowedInMode } from "./tools.js";
import { createMcpServer } from "../mcp/tools.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-503/acs/ac-${n}`;

const cleanup = { memexes: [] as string[], docs: [] as string[], users: [] as string[] };

afterAll(async () => {
  if (cleanup.docs.length) {
    await db.delete(standardClauses).where(inArray(standardClauses.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function makeUser(prefix: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `s503-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
    } as never)
    .returning();
  cleanup.users.push(u.id);
  return u.id;
}

async function slugsFor(memexId: string): Promise<{ namespace: string; memex: string }> {
  const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!m) throw new Error(`memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, m.namespaceId) });
  if (!ns) throw new Error(`namespace for memex ${memexId} not found`);
  return { namespace: ns.slug, memex: m.slug };
}

// Real resolver behind the ctx `resolveRef` hook (mirrors buildAgentCtx).
function ctxWithResolver(memexId: string, userId: string, verbose = false): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const { parseRef } = await import("../services/refs.js");
      const { resolveRef: resolveCanonicalRef } = await import("../services/resolver.js");
      const { NotFoundError } = await import("../types/errors.js");
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) throw new ValidationError(`Ref redirected: ${result.newRef}`);
      if ("notFound" in result) throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      // spec-521 dec-2: mirrors the production wrapper's archived-doc branch so the
      // ResolveResult union stays exhaustively narrowed. Unreachable in this file.
      if ("archivedDoc" in result) throw new NotFoundError(`Ref "${ref}" not found.`);
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
    workspaceUrl: async () => "https://test.example",
    verbose,
  } as ToolCtx;
}

function editSectionSpec() {
  const spec = toolSpecs.find((s) => s.name === "edit_section");
  if (!spec) throw new Error("edit_section ToolSpec not found");
  return spec;
}

interface Fixture {
  memexId: string;
  userId: string;
  sectionRef: string;
  sectionId: string;
}

const ORIGINAL = "The quick brown fox.\nA second line with token and token again.\n";

async function makeSpecFixture(prefix: string): Promise<Fixture> {
  const userId = await makeUser(prefix);
  const memexId = await makeTestMemex(`s503${prefix}`);
  cleanup.memexes.push(memexId);
  const doc = await createDocDraft(memexId, `spec-503 ${prefix}`, "purpose", "spec");
  cleanup.docs.push(doc.id);
  const section = await addSection(memexId, doc.id, `body-${prefix}`, ORIGINAL);
  const slugs = await slugsFor(memexId);
  return {
    memexId,
    userId,
    sectionId: section.id,
    sectionRef: `${slugs.namespace}/${slugs.memex}/specs/${doc.handle}/sections/s-${section.seq}`,
  };
}

async function storedContent(sectionId: string): Promise<string> {
  const row = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return row!.content;
}

describe("edit_section: successful edits", () => {
  it("replaces a single unique hit without re-emitting the body; terse payload carries count + ref", async () => {
    tagAc(AC(1));
    tagAc(AC(11));
    const fx = await makeSpecFixture("single");
    const result = await editSectionSpec().handler(
      { ref: fx.sectionRef, oldText: "quick brown fox", newText: "slow green turtle" },
      ctxWithResolver(fx.memexId, fx.userId),
    );
    expect(result).toBe(`Section edited: 1 occurrence(s) replaced (ref: ${fx.sectionRef}).`);
    expect(await storedContent(fx.sectionId)).toBe(
      "The slow green turtle.\nA second line with token and token again.\n",
    );
  });

  it("replaceAll replaces every occurrence and reports the count", async () => {
    tagAc(AC(3));
    const fx = await makeSpecFixture("all");
    const result = await editSectionSpec().handler(
      { ref: fx.sectionRef, oldText: "token", newText: "value", replaceAll: true },
      ctxWithResolver(fx.memexId, fx.userId),
    );
    expect(result).toBe(`Section edited: 2 occurrence(s) replaced (ref: ${fx.sectionRef}).`);
    expect(await storedContent(fx.sectionId)).toContain("value and value again");
  });

  it("stamps the acting user on the section row (std-32, via updateSection)", async () => {
    tagAc(AC(10));
    const fx = await makeSpecFixture("actor");
    await editSectionSpec().handler(
      { ref: fx.sectionRef, oldText: "fox", newText: "hare" },
      ctxWithResolver(fx.memexId, fx.userId),
    );
    const row = await db.query.docSections.findFirst({ where: eq(docSections.id, fx.sectionId) });
    expect(row!.actorUserId).toBe(fx.userId);
  });

  it("verbose: true returns full document state instead of the terse line", async () => {
    tagAc(AC(11));
    const fx = await makeSpecFixture("verbose");
    const result = await editSectionSpec().handler(
      { ref: fx.sectionRef, oldText: "fox", newText: "lynx", verbose: true },
      ctxWithResolver(fx.memexId, fx.userId, true),
    );
    expect(result).not.toBe(`Section edited: 1 occurrence(s) replaced (ref: ${fx.sectionRef}).`);
    expect(result).toContain("lynx");
  });
});

describe("edit_section: failure paths write nothing", () => {
  it("zero hits: ValidationError names the ref, exactness, and the get_doc re-read; content untouched", async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    const fx = await makeSpecFixture("zero");
    const ctx = ctxWithResolver(fx.memexId, fx.userId);
    await expect(
      editSectionSpec().handler({ ref: fx.sectionRef, oldText: "absent text", newText: "x" }, ctx),
    ).rejects.toThrow(/oldText not found in .*s-\d+.*exact.*get_doc/s);
    expect(await storedContent(fx.sectionId)).toBe(ORIGINAL);
  });

  it("ambiguous hits with replaceAll false: error names the count and both remedies; content untouched", async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    const fx = await makeSpecFixture("ambig");
    const ctx = ctxWithResolver(fx.memexId, fx.userId);
    await expect(
      editSectionSpec().handler({ ref: fx.sectionRef, oldText: "token", newText: "x" }, ctx),
    ).rejects.toThrow(/matches 2 places .*Widen oldText.*replaceAll: true/s);
    expect(await storedContent(fx.sectionId)).toBe(ORIGINAL);
  });

  it("empty oldText and oldText===newText are rejected before any write", async () => {
    tagAc(AC(12));
    const fx = await makeSpecFixture("guards");
    const ctx = ctxWithResolver(fx.memexId, fx.userId);
    await expect(
      editSectionSpec().handler({ ref: fx.sectionRef, oldText: "", newText: "x" }, ctx),
    ).rejects.toThrow(/must not be empty.*update_section/s);
    await expect(
      editSectionSpec().handler({ ref: fx.sectionRef, oldText: "token", newText: "token" }, ctx),
    ).rejects.toThrow(/identical/);
    expect(await storedContent(fx.sectionId)).toBe(ORIGINAL);
  });

  it("a doc-level ref is rejected (section refs only)", async () => {
    tagAc(AC(8));
    const fx = await makeSpecFixture("doclevel");
    const docRef = fx.sectionRef.replace(/\/sections\/s-\d+$/, "");
    await expect(
      editSectionSpec().handler({ ref: docRef, oldText: "a", newText: "b" }, ctxWithResolver(fx.memexId, fx.userId)),
    ).rejects.toThrow(/expects a section ref/);
  });
});

describe("edit_section: standards reject at the clause-grain gate", () => {
  it("redirects to add_clause / edit_clause / delete_clause and writes nothing", async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    const userId = await makeUser("std");
    const memexId = await makeTestMemex("s503std");
    cleanup.memexes.push(memexId);
    const std = await createStandard(memexId, {
      title: "spec-503 gate standard",
      sections: [{ sectionType: "rule", content: "One aspect." }],
    });
    cleanup.docs.push(std.id);
    const section = std.sections[0];
    const slugs = await slugsFor(memexId);
    const ref = `${slugs.namespace}/${slugs.memex}/standards/${std.handle}/sections/s-${section.seq}`;
    await expect(
      editSectionSpec().handler(
        { ref, oldText: "One aspect.", newText: "Another." },
        ctxWithResolver(memexId, userId),
      ),
    ).rejects.toThrow(/clause grain.*add_clause \/ edit_clause \/ delete_clause/s);
  });
});

describe("edit_section: surface wiring (std-16, one catalogue)", () => {
  it("is exposed to the in-app 'spec' mode and to the MCP endpoint from the same toolSpecs", () => {
    tagAc(AC(6));
    tagAc(AC(10));
    expect(getToolDefinitions().map((t) => t.name)).toContain("edit_section");
    const server = createMcpServer("00000000-0000-0000-0000-0000000000ff");
    const mcpNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(mcpNames).toContain("edit_section");
  });

  it("is absent from every scoped mode allow-list", () => {
    tagAc(AC(10));
    for (const mode of ["drift", "scaffold", "standards", "issues", "skills"] as const) {
      expect(isToolAllowedInMode(mode, "edit_section")).toBe(false);
    }
    expect(isToolAllowedInMode(undefined, "edit_section")).toBe(true);
  });
});
