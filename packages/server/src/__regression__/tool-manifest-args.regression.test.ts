// b-67: ARG-signature parity between the live Zod catalogue and the manifest.
//
// `tools-coverage.regression.test.ts` already pins tool NAMES: the manifest's
// name set == the registered MCP surface, and manifestVsSpecsDiff() proves the
// catalogue ↔ manifest names are in sync. But name parity says nothing about
// the `args` STRINGS the manifest carries (e.g. "list_docs(memex?, docType?)").
// Those strings feed the React UI Init Prompt's MEMEX_MCP_TOOLS_REFERENCE block
// verbatim, so if a spec gains/loses/reorders a field — or flips a field's
// optionality — the manifest string silently drifts and the coding agent gets
// a wrong signature.
//
// This test closes that gap: for every tool in `toolSpecs` it derives the
// EXPECTED signature from the live Zod schema (field names in declaration
// order, each suffixed `?` when the field accepts `undefined`) and asserts it
// equals the manifest's `args` (minus the `<name>(` prefix and `)` suffix).
//
// Conventions established by reading the spec source:
//   - The shared `verbose` field (VERBOSE_FIELD) is appended to every spec's
//     schema but is intentionally OMITTED from the manifest signatures, so it
//     is excluded from the comparison here.
//   - `list_memexes` is registered inline in mcp/tools.ts (NOT in toolSpecs);
//     its manifest signature is `list_memexes()`. It's handled as a known
//     exception below — asserted to take no args.

import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { toolManifest } from "@memex/shared";
import { toolSpecs } from "../agent/tool-specs.js";

// The one MCP tool that lives inline in mcp/tools.ts rather than in toolSpecs.
const INLINE_MCP_ONLY = "list_memexes";

// Fields that exist on the live schema but are intentionally absent from the
// manifest signatures.
const OMITTED_FROM_MANIFEST = new Set<string>(["verbose"]);

/**
 * A Zod field is "optional" for signature purposes if it accepts `undefined`
 * — i.e. it was built with `.optional()`, `.default()`, or
 * `.nullable().optional()`. `safeParse(undefined).success` captures all three
 * uniformly (a `.default()` field parses `undefined` into its default), which
 * is exactly the runtime meaning the manifest's `?` marker conveys.
 */
function isOptionalField(zt: ZodType): boolean {
  return zt.safeParse(undefined).success;
}

/**
 * Build the expected argument signature inner-string for a spec from its live
 * Zod shape: declaration-order field names, `?`-suffixed when optional, joined
 * with ", " — and the shared `verbose` field stripped.
 */
function expectedInnerSignature(schema: Record<string, ZodType>): string {
  const parts: string[] = [];
  for (const [field, zt] of Object.entries(schema)) {
    if (OMITTED_FROM_MANIFEST.has(field)) continue;
    parts.push(isOptionalField(zt) ? `${field}?` : field);
  }
  return parts.join(", ");
}

/**
 * Strip the `<name>(` prefix and `)` suffix off a manifest `args` string,
 * returning the inner argument list (possibly empty).
 */
function manifestInnerSignature(name: string, args: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return args.replace(new RegExp(`^${escaped}\\(`), "").replace(/\)$/, "");
}

describe("regression: manifest ↔ specs name cross-check (b-67)", () => {
  it("manifestVsSpecsDiff() is empty against the real data", async () => {
    const { manifestVsSpecsDiff } = await import("../agent/tool-specs.js");
    const { inSpecsNotManifest, inManifestNotSpecs } = manifestVsSpecsDiff();
    expect({ inSpecsNotManifest, inManifestNotSpecs }).toEqual({
      inSpecsNotManifest: [],
      inManifestNotSpecs: [],
    });
  });
});

describe("regression: tool manifest arg-signature parity (b-67)", () => {
  const manifestByName = new Map(toolManifest.map((e) => [e.name, e]));

  it("every toolSpecs tool has a matching manifest entry", () => {
    const missing = toolSpecs
      .map((s) => s.name)
      .filter((n) => !manifestByName.has(n))
      .sort();
    expect(missing, missing.length ? `not in manifest: ${missing.join(", ")}` : "").toEqual([]);
  });

  // One assertion per tool so a single drift names the exact tool + diff.
  for (const spec of toolSpecs) {
    it(`${spec.name}: manifest args match the live Zod schema`, () => {
      const entry = manifestByName.get(spec.name);
      expect(entry, `${spec.name} missing from manifest`).toBeDefined();
      if (!entry) return;

      const expected = expectedInnerSignature(spec.schema as Record<string, ZodType>);
      const actual = manifestInnerSignature(spec.name, entry.args);

      expect(
        actual,
        `Manifest args for ${spec.name} drifted from the live Zod schema.\n` +
          `  manifest: "${spec.name}(${actual})"\n` +
          `  schema  : "${spec.name}(${expected})"\n` +
          `Fix packages/shared/src/tool-manifest.ts (field order / names / '?' optionality) ` +
          `to match the schema in packages/server/src/agent/tool-specs.ts — or, if the schema ` +
          `is what changed, this is the manifest reminding you to update it.`,
      ).toBe(expected);

      // Field-name set equality (order-independent) — a second, more granular
      // signal so a pure reordering vs. a missing/extra field are distinguishable.
      const expectedFields = expected
        .split(", ")
        .filter(Boolean)
        .map((f) => f.replace(/\?$/, ""))
        .sort();
      const actualFields = actual
        .split(", ")
        .filter(Boolean)
        .map((f) => f.replace(/\?$/, ""))
        .sort();
      expect(actualFields, `${spec.name}: field-name set mismatch`).toEqual(expectedFields);
    });
  }

  it("verbose is omitted from every manifest signature (none list it)", () => {
    const leaked = toolManifest
      .filter((e) => manifestInnerSignature(e.name, e.args).split(", ").includes("verbose"))
      .map((e) => e.name);
    expect(leaked, leaked.length ? `leak verbose: ${leaked.join(", ")}` : "").toEqual([]);
  });

  it(`${INLINE_MCP_ONLY} is the inline MCP-only exception with no args`, () => {
    // It's NOT in toolSpecs; its manifest signature carries no arguments.
    expect(toolSpecs.some((s) => s.name === INLINE_MCP_ONLY)).toBe(false);
    const entry = manifestByName.get(INLINE_MCP_ONLY);
    expect(entry, `${INLINE_MCP_ONLY} missing from manifest`).toBeDefined();
    if (!entry) return;
    expect(entry.args).toBe(`${INLINE_MCP_ONLY}()`);
    expect(manifestInnerSignature(INLINE_MCP_ONLY, entry.args)).toBe("");
  });
});
