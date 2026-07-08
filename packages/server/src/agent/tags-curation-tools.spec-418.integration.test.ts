// spec-418 t-4 — the tag-catalogue curation MCP tools (create_tag / rename_tag /
// delete_tag).
//
// Proves the three tools are:
//   - present in the @memex/shared manifest AND registered on the live MCP surface
//     (ac-20 / ac-28 — the parity the b-67 regression tests also guard);
//   - thin wrappers over the SAME services/tags.ts curation functions REST calls,
//     with a blocked rename surfacing the SAME plain-reason message the service
//     throws (ac-6 / ac-21);
//   - described PORTABLY — no repo paths, no language/framework/tooling tokens
//     (ac-22 / std-22).
//
// DB-backed: drives each tool's HANDLER directly against a real Postgres via a
// hand-built ToolCtx (mirrors tool-specs.tags.integration.test.ts). TAGGED with
// tagAc → emits to the PROD memex; a human runs the tagged suite. Fixture-isolated
// per std-37 (makeTestMemex mints a unique tenant per suite).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { db } from "../db/connection.js";
import {
  memexes,
  documents,
  tags as tagsTable,
  documentTags,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { getOrCreateTag, setTagOnDoc, listDocTags, formatTag } from "../services/tags.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";
import { createMcpServer } from "../mcp/tools.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-418/acs";
const AC_6 = `${AC}/ac-6`;
const AC_20 = `${AC}/ac-20`;
const AC_21 = `${AC}/ac-21`;
const AC_22 = `${AC}/ac-22`;
const AC_28 = `${AC}/ac-28`;

const CURATION_TOOLS = ["create_tag", "rename_tag", "delete_tag"] as const;

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

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec not found: ${name}`);
  return spec;
}

// The set of tool names the live MCP server registers (mirrors the b-67 parity
// regression test's introspection of the server's private registry).
function listMcpToolNames(): Set<string> {
  const server = createMcpServer("00000000-0000-0000-0000-0000000418ac");
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return new Set(Object.keys(tools));
}

// A memex-scoped ToolCtx: the curation tools resolve the workspace (not a Spec
// ref), so resolveMemex is the only resolver they touch.
function ctxFor(memexId: string, userId: string): ToolCtx {
  return {
    userId,
    channel: "mcp",
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async () => {
      throw new Error("resolveRef not expected for tag-curation tools");
    },
    workspaceUrl: async () => "",
    verbose: false,
  };
}

describe("spec-418 t-4 — curation tools present in the manifest AND registered on MCP (ac-20/ac-28)", () => {
  it("create_tag / rename_tag / delete_tag appear in BOTH the manifest and the MCP surface", () => {
    tagAc(AC_20);
    tagAc(AC_28);
    const manifestNames = new Set(toolManifest.map((e) => e.name));
    const mcpNames = listMcpToolNames();
    for (const name of CURATION_TOOLS) {
      expect(manifestNames.has(name), `${name} missing from @memex/shared manifest`).toBe(true);
      expect(mcpNames.has(name), `${name} not registered on the MCP surface`).toBe(true);
    }
  });

  it("all three are mutating (readOnlyHint:false) with null homePhase; delete_tag is destructive", () => {
    tagAc(AC_20);
    const byName = new Map(toolManifest.map((e) => [e.name, e]));
    for (const name of CURATION_TOOLS) {
      const entry = byName.get(name);
      expect(entry, `${name} missing from manifest`).toBeDefined();
      expect(entry!.readOnlyHint, `${name} must be mutating`).toBe(false);
      expect(entry!.homePhase, `${name} must not drive a phase`).toBeNull();
    }
    expect(specByName("delete_tag").annotations.destructiveHint).toBe(true);
    expect(specByName("create_tag").annotations.destructiveHint).toBe(false);
    expect(specByName("rename_tag").annotations.destructiveHint).toBe(false);
  });
});

describe("spec-418 t-4 — same tags service functions as REST; same refusal (ac-6/ac-21)", () => {
  let memexId: string;
  let userId: string;
  let docId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("spec418-t4");
    cleanup.memexes.push(memexId);
    // document_tags.added_by is an FK to users(id); use a real row.
    userId = (await upsertUserByEmail("spec418-t4@example.com")).id;
    const doc = await createDocDraft(memexId, "Curated Spec", "Tag curation over MCP.", "spec");
    docId = doc.id;
    cleanup.docs.push(doc.id);
  });

  it("create_tag mints a catalogue row via the tags service", async () => {
    tagAc(AC_21);
    tagAc(AC_28);
    const out = await specByName("create_tag").handler(
      { tag: "priority::high" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/priority::high/);
    const rows = await db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.memexId, memexId));
    const made = rows.find((r) => r.scope === "priority" && r.value === "high");
    expect(made, "create_tag did not persist the catalogue row").toBeDefined();
  });

  it("create_tag BLOCKS a duplicate with the service's plain-reason message", async () => {
    tagAc(AC_21);
    await getOrCreateTag({}, memexId, "size", "small");
    await expect(
      specByName("create_tag").handler({ tag: "size::small" }, ctxFor(memexId, userId)),
    ).rejects.toThrowError(/A tag named "size::small" already exists/);
  });

  it("rename_tag renames — reflected on the carrying Spec", async () => {
    tagAc(AC_6);
    tagAc(AC_21);
    const t = await getOrCreateTag({}, memexId, "stage", "alpha");
    await setTagOnDoc({}, memexId, docId, t);
    const out = await specByName("rename_tag").handler(
      { tag: "stage::alpha", newTag: "stage::beta" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/stage::alpha/);
    expect(out).toMatch(/stage::beta/);
    const onDoc = (await listDocTags(memexId, docId)).map(formatTag);
    expect(onDoc).toContain("stage::beta");
    expect(onDoc).not.toContain("stage::alpha");
  });

  it("rename_tag on an absent tag → NotFoundError", async () => {
    tagAc(AC_21);
    await expect(
      specByName("rename_tag").handler(
        { tag: "ghost::none", newTag: "ghost::there" },
        ctxFor(memexId, userId),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a BLOCKED rename returns the SAME plain-reason message the service throws (ac-21)", async () => {
    tagAc(AC_6);
    tagAc(AC_21);
    // Two catalogue tags; renaming one onto the other's (scope,value) is the
    // duplicate block — the SAME ValidationError message REST surfaces at 400.
    const src = await getOrCreateTag({}, memexId, "dup", "src");
    await getOrCreateTag({}, memexId, "dup", "target");

    // Cross-check the message text against the service called directly on the SAME
    // inputs: the tool must not reword the refusal (ac-21).
    let serviceMsg = "";
    try {
      const { renameTag } = await import("../services/tags.js");
      await renameTag({}, memexId, src.id, "dup", "target");
    } catch (err) {
      serviceMsg = (err as Error).message;
    }
    // renameTag succeeded above? (it must not — src is still dup::src) — re-fetch to
    // confirm the service-direct call was itself a no-op block.
    expect(serviceMsg, "expected the direct service call to block").toMatch(/already exists/i);

    await expect(
      specByName("rename_tag").handler(
        { tag: "dup::src", newTag: "dup::target" },
        ctxFor(memexId, userId),
      ),
    ).rejects.toThrowError(new RegExp(serviceMsg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // A different ValidationError type is fine to assert too — it IS a ValidationError.
    await expect(
      specByName("rename_tag").handler(
        { tag: "dup::src", newTag: "dup::target" },
        ctxFor(memexId, userId),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("delete_tag removes the catalogue row and its links", async () => {
    tagAc(AC_6);
    tagAc(AC_21);
    const t = await getOrCreateTag({}, memexId, "temp", "gone");
    await setTagOnDoc({}, memexId, docId, t);
    const out = await specByName("delete_tag").handler(
      { tag: "temp::gone" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/temp::gone/);
    const rows = await db.select().from(tagsTable).where(eq(tagsTable.id, t.id));
    expect(rows.length, "delete_tag left the catalogue row").toBe(0);
    const onDoc = (await listDocTags(memexId, docId)).map(formatTag);
    expect(onDoc).not.toContain("temp::gone");
  });

  it("delete_tag on an absent tag → NotFoundError (never creates a row)", async () => {
    tagAc(AC_21);
    await expect(
      specByName("delete_tag").handler({ tag: "nope::nada" }, ctxFor(memexId, userId)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // dec-8: tag identity is CASE-INSENSITIVE (the 0125 CI unique index stores exactly
  // one row per canonical (memex, lower(scope), lower(value))). The MCP tools promise
  // "Matching is case-insensitive" in TAG_ARG_DESC, so an agent naming a tag in a
  // different casing than stored MUST still resolve the existing row — not 404.
  it("rename_tag resolves the current tag case-insensitively (dec-8)", async () => {
    tagAc(AC_6);
    tagAc(AC_21);
    // Stored casing is lower; the agent supplies an upper-case variant.
    const t = await getOrCreateTag({}, memexId, "cirename", "old");
    await setTagOnDoc({}, memexId, docId, t);
    const out = await specByName("rename_tag").handler(
      { tag: "CIRENAME::OLD", newTag: "cirename::new" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/cirename::new/);
    const onDoc = (await listDocTags(memexId, docId)).map(formatTag);
    expect(onDoc).toContain("cirename::new");
    expect(onDoc).not.toContain("cirename::old");
  });

  it("delete_tag resolves the target tag case-insensitively (dec-8)", async () => {
    tagAc(AC_21);
    // Stored casing is lower; the agent supplies an upper-case variant.
    const t = await getOrCreateTag({}, memexId, "cidelete", "value");
    const out = await specByName("delete_tag").handler(
      { tag: "CIDELETE::VALUE" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/cidelete::value/);
    const rows = await db.select().from(tagsTable).where(eq(tagsTable.id, t.id));
    expect(rows.length, "delete_tag did not resolve the case-variant target").toBe(0);
  });

  // A flat (scope = null) tag must fold on value casing too (0125 lower(value) with
  // scope IS NULL).
  it("delete_tag resolves a flat tag case-insensitively (dec-8)", async () => {
    tagAc(AC_21);
    const t = await getOrCreateTag({}, memexId, null, "flatci");
    const out = await specByName("delete_tag").handler(
      { tag: "FLATCI" },
      ctxFor(memexId, userId),
    );
    expect(out).toMatch(/flatci/);
    const rows = await db.select().from(tagsTable).where(eq(tagsTable.id, t.id));
    expect(rows.length, "delete_tag did not resolve the flat case-variant").toBe(0);
  });
});

describe("spec-418 t-4 — tool descriptions are portable (ac-22/std-22)", () => {
  it("no repo path / language / framework / tooling tokens leak into descriptions or field descs", () => {
    tagAc(AC_22);
    // Repo paths, test-runner / package-manager names, and language/framework
    // tokens a portable artifact must never assume (std-22).
    const FORBIDDEN =
      /\bvitest\b|\bpnpm\b|\bnpm\b|\byarn\b|packages\/|src\/|drizzle|\bhono\b|\breact\b|typescript|\bzod\b|postgres|\.ts\b|\.tsx\b|node_modules/i;
    for (const name of CURATION_TOOLS) {
      const spec = specByName(name);
      const texts = [
        spec.description,
        ...Object.values(spec.schema).map((z) => (z as { description?: string }).description ?? ""),
      ];
      for (const text of texts) {
        expect(
          FORBIDDEN.test(text),
          `${name} description leaks a non-portable token: ${text}`,
        ).toBe(false);
      }
    }
  });
});
