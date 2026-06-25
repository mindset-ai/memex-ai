// spec-306 — unit coverage for the document-attribution prop shape and its
// behaviour through the shared sanitiser. No DB: pure shape + sanitiser checks.
//
//  - ac-1/ac-2/ac-3 (scope): the props are an opaque UUID + doc_type enum, no
//    handle / slug / ref, and survive sanitizeUsageProps unchanged.
//  - ac-7 (impl): no handle / namespace / slug / qualified ref in the props.
//  - ac-8 / ac-11 (impl): doc_id (UUID) and doc_type (enum) pass
//    sanitizeUsageProps unchanged.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { sanitizeUsageProps } from "@memex/shared";
import { docAttribution } from "./shared/doc-attribution.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-306/acs";

const UUID = "3f1a2b3c-4d5e-6f70-8190-a1b2c3d4e5f6";

describe("docAttribution — shape (spec-306 dec-1)", () => {
  it("emits exactly { doc_id, doc_type } — UUID + enum, nothing else", () => {
    tagAc(`${AC}/ac-7`);
    const props = docAttribution(UUID, "spec");
    expect(Object.keys(props).sort()).toEqual(["doc_id", "doc_type"]);
    expect(props.doc_id).toBe(UUID);
    expect(props.doc_type).toBe("spec");
  });

  it("carries no human handle, namespace, Memex slug, or qualified ref", () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-2`); // scope: props obey the std-35 privacy rule (IDs/enums only, no titles/content/PII)
    const props = docAttribution(UUID, "standard");
    for (const v of Object.values(props)) {
      const s = String(v);
      expect(s).not.toMatch(/^[a-z]+-\d+$/i); // not a handle like spec-42
      expect(s).not.toContain("/"); // not a slug / qualified ref
    }
  });
});

describe("docAttribution — survives sanitizeUsageProps (spec-306 ac-8/ac-11)", () => {
  it("doc_id (UUID) and doc_type (enum) pass the sanitiser unchanged", () => {
    tagAc(`${AC}/ac-8`);
    tagAc(`${AC}/ac-11`);
    const out = sanitizeUsageProps(docAttribution(UUID, "spec"));
    expect(out).toEqual({ doc_id: UUID, doc_type: "spec" });
  });

  it("merges cleanly with sibling props (e.g. {from,to}, {spec_index})", () => {
    tagAc(`${AC}/ac-11`);
    const merged = { from: "draft", to: "specify", ...docAttribution(UUID, "spec") };
    expect(sanitizeUsageProps(merged)).toEqual({
      from: "draft",
      to: "specify",
      doc_id: UUID,
      doc_type: "spec",
    });
  });
});
