// spec-529 t-6 (ac-7, dec-3) — the MCP surface is OUT OF SCOPE for this Spec, and
// this test is what keeps it that way.
//
// The temptation is real: the pill resolves every handle a body mentions, so it
// looks natural to hand an agent the same thing. dec-3 says no. An agent can
// already fetch a referenced Spec's status whenever it wants one; the reader who
// cannot is the human looking at a rendered page. So `get_doc` must return the
// body byte-for-byte, with nothing appended and no status attached — and the
// tool catalogue must not have grown a resolution tool either.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { docsTools } from "./docs.js";

describe("get_doc is untouched by spec-529", () => {
  it("appends no resolved-references block to its description or schema", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-7");
    const getDoc = docsTools.find((t) => t.name === "get_doc");
    expect(getDoc).toBeDefined();
    const description = getDoc?.description ?? "";
    // Nothing in the contract offers resolved status for referenced handles.
    expect(description).not.toMatch(/referenced spec/i);
    expect(description).not.toMatch(/task progress|taskProgress/i);
    expect(Object.keys(getDoc?.schema ?? {})).toEqual(["ref", "verbose"]);
  });

  it("adds no reference-resolution tool to the catalogue", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-7");
    const names = docsTools.map((t) => t.name);
    expect(names).not.toContain("resolve_spec_refs");
    expect(names.filter((n) => /ref|pill|handle/i.test(n))).toEqual([]);
  });

  it("exposes no handle-resolution argument an agent could ask status through", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-7");
    const getDoc = docsTools.find((t) => t.name === "get_doc");
    // The whole surface an agent can reach is ref + verbose. There is no opt-in
    // that would return resolved status for the handles a body mentions, which is
    // what dec-3 decided against.
    const schema = getDoc?.schema ?? {};
    expect(Object.keys(schema)).toEqual(["ref", "verbose"]);
    expect(Object.keys(schema)).not.toContain("resolveRefs");
    expect(Object.keys(schema)).not.toContain("includeReferencedSpecs");
  });

});
