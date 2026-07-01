// spec-438 t-7 (ac-13): the bootstrap protocol is existing-standards-aware. A
// STEP 0 runs BEFORE authoring: it consults the standards the Memex already has
// and, when some exist, switches from cold-start to INCREMENTAL mode — proposing
// only rules not already covered (no duplicates) and flagging contradictions as
// drift instead of authoring competing standards. This closes the footgun where a
// developer-invoked run on a Memex that already has standards would re-derive and
// duplicate them. Guards the STEP 0 contract against being hollowed out.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { fetchTopic } from "../services/guidance.js";

const AC13 = "mindset-prod/memex-building-itself/specs/spec-438/acs/ac-13";

describe("spec-438 t-7 — existing-standards-aware bootstrap (ac-13)", () => {
  it("STEP 0 consults the existing standards before authoring", async () => {
    tagAc(AC13);
    const { body } = await fetchTopic("standards-bootstrap");
    expect(body).toMatch(/STEP 0/);
    // it reads the existing standard corpus first (not just the facet vocabulary)
    expect(body).toContain("list_docs");
    expect(body).toContain("search_memex");
  });

  it("when standards already exist, it runs incrementally: dedup + contradiction→drift, not cold-start", async () => {
    tagAc(AC13);
    const { body } = await fetchTopic("standards-bootstrap");
    expect(body).toMatch(/incremental/i);
    // dedup: propose only what is not already covered
    expect(body).toMatch(/not already covered|already there|never duplicate|do not duplicate|already covered/i);
    // contradiction with an existing standard routes to drift, not a competing standard
    expect(body).toMatch(/contradict/i);
    expect(body).toContain("flag_drift");
    // and it explicitly relaxes the cold-start / first-contact framing
    expect(body).toMatch(/NOT first contact|not first contact|extending an existing set/i);
  });

  it("the when_to_read hint covers both cold start and extending an existing set", async () => {
    tagAc(AC13);
    const { whenToRead } = await fetchTopic("standards-bootstrap");
    expect(whenToRead).toMatch(/cold start|no standards/i);
    expect(whenToRead).toMatch(/extending an existing set|already ha(s|ve) some|new repository|previously unexplored/i);
  });
});
