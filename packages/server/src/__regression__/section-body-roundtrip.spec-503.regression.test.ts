// spec-503 (ac-5): the byte-identity guarantee that makes edit_section usable.
// Agents copy oldText from get_doc output, so the section body get_doc renders
// must contain the stored doc_sections.content VERBATIM: no decoration,
// escaping, numbering, or reflow inside the body. If this test goes red,
// edit_section's exact matching silently stops working for copy-pasted text,
// and agents fall back to whole-body update_section.
import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, documents, docSections, users } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { ValidationError } from "../types/errors.js";
import { toolSpecs, type ToolCtx } from "../agent/tool-specs.js";

const AC_ROUNDTRIP = "mindset-prod/memex-building-itself/specs/spec-503/acs/ac-5";

// Markdown-heavy fixture: code fences, inline code, nested lists, blank lines,
// tabs, trailing spaces, $-sequences, unicode punctuation and emoji. Anything
// a Spec section realistically contains must survive the roundtrip unchanged.
const GNARLY = [
  "# Heading with `inline code` and *emphasis*",
  "",
  "- item one",
  "  - nested with two-space indent",
  "",
  "```ts",
  'const x: Record<string, number> = { "a": 1 };',
  "```",
  "",
  "Text with $& and $1 and a\ttab, plus unicode: café ☕ → «done».",
  "Trailing spaces stay:  ",
  "> a quote line",
].join("\n");

const cleanup = { memexes: [] as string[], docs: [] as string[], users: [] as string[] };

afterAll(async () => {
  if (cleanup.docs.length) {
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

function spec(name: string) {
  const s = toolSpecs.find((t) => t.name === name);
  if (!s) throw new Error(`ToolSpec not found: ${name}`);
  return s;
}

function ctxWithResolver(memexId: string, userId: string, verbose = false): ToolCtx {
  return {
    userId,
    verbose,
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
  } as ToolCtx;
}

describe("spec-503 roundtrip: get_doc body === stored content", () => {
  it("renders the stored section body verbatim, and text copied from get_doc matches in edit_section", async () => {
    tagAc(AC_ROUNDTRIP);
    const [u] = await db
      .insert(users)
      .values({
        email: `s503-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
      } as never)
      .returning();
    cleanup.users.push(u.id);
    const memexId = await makeTestMemex("s503rt");
    cleanup.memexes.push(memexId);
    const doc = await createDocDraft(memexId, "spec-503 roundtrip", "purpose", "spec");
    cleanup.docs.push(doc.id);
    const section = await addSection(memexId, doc.id, "gnarly", GNARLY);

    const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
    const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, m!.namespaceId) });
    const docRef = `${ns!.slug}/${m!.slug}/specs/${doc.handle}`;
    const ctx = ctxWithResolver(memexId, u.id);

    // 1. The get_doc rendering (the verbose body-carrying form agents read
    // content from) contains the stored body byte-for-byte.
    const rendered = (await spec("get_doc").handler(
      { ref: docRef, verbose: true },
      ctxWithResolver(memexId, u.id, true),
    )) as string;
    expect(rendered).toContain(GNARLY);

    // 2. Copy oldText OUT OF the get_doc output (provenance matters: this is
    // exactly what an agent does) and edit with it.
    const start = rendered.indexOf('const x: Record<string, number> = { "a": 1 };');
    expect(start).toBeGreaterThan(-1);
    const copied = rendered.slice(start, start + 'const x: Record<string, number> = { "a": 1 };'.length);
    const sectionRef = `${docRef}/sections/s-${section.seq}`;
    const result = await spec("edit_section").handler(
      { ref: sectionRef, oldText: copied, newText: 'const x: Record<string, number> = { "a": 2 };' },
      ctx,
    );
    expect(result).toBe(`Section edited: 1 occurrence(s) replaced (ref: ${sectionRef}).`);

    const row = await db.query.docSections.findFirst({ where: eq(docSections.id, section.id) });
    expect(row!.content).toBe(GNARLY.replace('"a": 1', '"a": 2'));
  });
});
