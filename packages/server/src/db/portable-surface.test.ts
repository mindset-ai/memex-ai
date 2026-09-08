// spec-551 t-1 — the rendered-prose enumeration that feeds the std-22 portability
// guard (dec-5).
//
// This asserts the COLLECTOR, not the deny-list: that every surface a reader
// actually receives is walked, that the metadata fields nobody receives are not,
// and that the module keeps one small interface so a second consumer with a
// different assertion (spec-511's tool-name integrity check) rides the same walk
// instead of writing a second one.
//
// Why each assertion exists is written next to it — each one is a mistake this
// Spec's own investigation actually made.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { SPEC_SHAPE_MISSING_LENS_WARNING } from "@memex/shared";
import * as portableSurface from "./portable-surface.js";
import { collectPortableSurface } from "./portable-surface.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-551/acs/ac-${n}`;

describe("spec-551: the portable-surface enumeration (dec-5)", () => {
  it("keeps one exported entry point, so a second consumer rides this walk (ac-13)", async () => {
    tagAc(AC(13));
    // std-51: a small interface over a lot of behaviour. Nothing is exported for a
    // test to reach inside — every assertion below goes through the one function.
    expect(Object.keys(portableSurface)).toEqual(["collectPortableSurface"]);
  });

  it("reaches all three rendered surfaces in one pass (ac-13)", async () => {
    tagAc(AC(13));
    const corpus = await collectPortableSurface();
    const sources = new Set(corpus.map((s) => s.where.split(":")[0]));

    expect(sources).toContain("scaffold");
    expect(sources).toContain("guidance");
    expect(sources).toContain("tool");
    // A walk that collapses to a handful of strings has stopped enumerating; the
    // real corpus is in the hundreds.
    expect(corpus.length).toBeGreaterThan(300);
  });

  it("reaches a bare exported prose constant, not only node text fields (ac-14)", async () => {
    tagAc(AC(14));
    // The first inventory pass for this Spec keyed on property names and missed
    // SPEC_SHAPE_MISSING_LENS_WARNING — a bare export that carries one of the
    // defects. A collector that silently skips a rendered field is the same class
    // of fault as the guard that looked at the wrong file.
    const corpus = await collectPortableSurface();
    const found = corpus.some((s) => s.text === SPEC_SHAPE_MISSING_LENS_WARNING);

    expect(found, "the missing-core-lens warning is rendered prose and must be walked").toBe(true);
  });

  it("reads the live tool contract from the registry, including field descriptions (ac-24)", async () => {
    tagAc(AC(24));
    // The surface that actually reaches an MCP client. Sourced by importing the
    // registry rather than reading files as text: a text scan sees comments, and
    // this repo's comments cite handles legitimately everywhere.
    const corpus = await collectPortableSurface();
    const toolEntries = corpus.filter((s) => s.where.startsWith("tool:"));

    expect(toolEntries.length).toBeGreaterThan(50);
    // The tool's own description...
    expect(toolEntries.some((s) => s.where === "tool:register_issue / description")).toBe(true);
    // ...and its argument descriptions, which ride the same JSON schema to the client.
    expect(toolEntries.some((s) => s.where.startsWith("tool:register_issue / arg:"))).toBe(true);
  });

  it("excludes the metadata fields no reader ever receives (ac-12)", async () => {
    tagAc(AC(12));
    // `rationale` and `notes` are scaffold provenance, stripped before sending
    // (toToolDefinition drops rationale explicitly) and dense with handles BY
    // DESIGN. Scanning them would produce hundreds of false hits and the guard
    // would be switched off within a week.
    //
    // Asserted as a field-shape rule, not a list of sites: no entry may be
    // labelled as coming from one of those fields.
    const corpus = await collectPortableSurface();
    const metadataEntries = corpus.filter((s) => /\/ (rationale|notes)$/.test(s.where));

    expect(metadataEntries).toEqual([]);
  });

  it("labels every entry with a locatable site (ac-13)", async () => {
    tagAc(AC(13));
    // A finding that cannot be located is a finding nobody acts on.
    const corpus = await collectPortableSurface();
    const unlabelled = corpus.filter((s) => !s.where || s.where.trim() === "");

    expect(unlabelled).toEqual([]);
  });
});
