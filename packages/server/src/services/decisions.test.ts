import { describe, it, expect } from "vitest";
import { parseDecisionHandle } from "./decisions.js";

// Pure unit tests for the cite handle parser. Resolver behaviour (account
// scope, parent docType assertion, ambiguity 409) lives in
// decisions.integration.test.ts because it needs a real database.

describe("parseDecisionHandle (t-7 / t-20 W-A / doc-26 / b-105)", () => {
  it("parses the canonical Spec form `mis-N:D-M`", () => {
    expect(parseDecisionHandle("mis-3:D-7")).toEqual({
      // Per b-105 Specs live at `spec-N`. The parser rewrites `mis-N` → `spec-N`
      // so the resolver hits documents.handle and `parentKind: 'spec'` tells it
      // to layer a docType assertion on top.
      docHandle: "spec-3",
      decSeq: 7,
      parentKind: "spec",
    });
  });

  it("accepts the legacy lowercase Spec form `mis-N:dec-M`", () => {
    // Standards content authored before the rename still emits `:dec-M`.
    // Both decision prefixes route to the same shape.
    expect(parseDecisionHandle("mis-3:dec-7")).toEqual({
      docHandle: "spec-3",
      decSeq: 7,
      parentKind: "spec",
    });
  });

  it("parses the legacy doc-qualified form `doc-N:dec-M`", () => {
    expect(parseDecisionHandle("doc-3:dec-7")).toEqual({
      docHandle: "doc-3",
      decSeq: 7,
      parentKind: "any",
    });
  });

  it("parses the doc-qualified form with the new D- decision prefix", () => {
    expect(parseDecisionHandle("doc-3:D-7")).toEqual({
      docHandle: "doc-3",
      decSeq: 7,
      parentKind: "any",
    });
  });

  it("parses the std-qualified form (`std-N:D-M`)", () => {
    expect(parseDecisionHandle("std-3:D-7")).toEqual({
      docHandle: "std-3",
      decSeq: 7,
      parentKind: "any",
    });
  });

  it("parses the spec-qualified typed form (`spec-N:D-M`)", () => {
    // Per b-105 specs live at `spec-N`; the qualified form is the typed sibling
    // of the `mis-N:D-M` cite syntax. `parentKind: 'any'` here — strict Spec
    // gating is the `mis-` prefix's job.
    expect(parseDecisionHandle("spec-3:D-7")).toEqual({
      docHandle: "spec-3",
      decSeq: 7,
      parentKind: "any",
    });
  });

  it("parses the new canonical bare form `D-N`", () => {
    expect(parseDecisionHandle("D-7")).toEqual({
      docHandle: null,
      decSeq: 7,
      parentKind: null,
    });
  });

  it("parses the legacy bare form `dec-N`", () => {
    expect(parseDecisionHandle("dec-7")).toEqual({
      docHandle: null,
      decSeq: 7,
      parentKind: null,
    });
  });

  it("returns null for malformed input", () => {
    expect(parseDecisionHandle("decision-1")).toBeNull();
    expect(parseDecisionHandle("mis-3")).toBeNull(); // missing :D-M
    expect(parseDecisionHandle("doc-3")).toBeNull(); // missing :D-M
    expect(parseDecisionHandle("mis-:D-7")).toBeNull();
    expect(parseDecisionHandle("D-")).toBeNull();
    expect(parseDecisionHandle("dec-")).toBeNull();
    expect(parseDecisionHandle("")).toBeNull();
    // The signature is `string` but defensive: non-string inputs return null
    // rather than throw — services pass through user/agent input.
    expect(parseDecisionHandle(undefined as unknown as string)).toBeNull();
    expect(parseDecisionHandle(null as unknown as string)).toBeNull();
  });

  it("does not match partial overlaps (anchored)", () => {
    expect(parseDecisionHandle("foo mis-3:D-7")).toBeNull();
    expect(parseDecisionHandle("mis-3:D-7 bar")).toBeNull();
    expect(parseDecisionHandle("mis-3:D-7:trailing")).toBeNull();
  });
});
