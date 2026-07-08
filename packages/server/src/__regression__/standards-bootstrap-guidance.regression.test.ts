// spec-438 t-1: the `standards-bootstrap` get_information topic — the portable
// cold-start protocol the developer's coding agent fetches and runs. The empty-
// standards Prompt Button (t-2) and the spec-422 empty-state nudge both point an
// agent here, so this topic must (a) load and appear in the index, (b) hold the
// two-register voice rule that keeps internal vocabulary away from the human
// (ac-2), (c) drive authoring through the real Memex flow with a deliberate facet
// verdict per clause (ac-1/ac-8), and (d) stay portable per std-22 (no language /
// framework / path / tooling assumptions). Guards against the file being deleted,
// hollowed out, or drifting into an unportable or vocabulary-leaking shape.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { listTopics, fetchTopic } from "../services/guidance.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-438";

describe("standards-bootstrap guidance topic", () => {
  it("exists, parses, and appears in the topic index (ac-1: the portable protocol exists)", async () => {
    tagAc(`${SPEC}/acs/ac-1`);
    const topics = await listTopics();
    const entry = topics.find((t) => t.topic === "standards-bootstrap");
    expect(entry, "standards-bootstrap must appear in the get_information index").toBeTruthy();
    expect(entry!.title.length).toBeGreaterThan(0);
    expect(entry!.whenToRead.length).toBeGreaterThan(0);

    const { body } = await fetchTopic("standards-bootstrap");
    expect(body.length).toBeGreaterThan(500);
    // when_to_read signals the cold-start / bootstrap trigger so an agent finds it
    expect(entry!.whenToRead).toMatch(/bootstrap|no standards|cold[- ]start|first/i);
  });

  it("holds the two-register voice rule and never leaks internal vocabulary to the human (ac-2)", async () => {
    tagAc(`${SPEC}/acs/ac-2`);
    const { body } = await fetchTopic("standards-bootstrap");
    // the overriding rule: two registers, internal vs human, never mixed
    expect(body).toMatch(/two registers/i);
    expect(body).toMatch(/INTERNAL/);
    expect(body).toMatch(/HUMAN/);
    // the internal words are explicitly named as never-to-the-human
    expect(body).toMatch(/never (say|hear)/i);
    expect(body).toMatch(/facet/);
    expect(body).toMatch(/clause/);
    // "standard" is introduced exactly once, plainly (the one product word taught)
    expect(body).toMatch(/a rule your team agrees to follow/i);
  });

  it("drives authoring through the real Memex flow with a deliberate facet verdict per clause (ac-8)", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const { body } = await fetchTopic("standards-bootstrap");
    // fetches the sibling authoring guidance rather than re-teaching it
    expect(body).toContain("get_information(topic='authoring-standards')");
    // reads the facet vocabulary and authors via the documented create flow
    expect(body).toMatch(/facets/);
    expect(body).toContain("create_doc");
    expect(body).toContain("add_section");
    // each authored clause carries a deliberate facet verdict (rides spec-437's ballot)
    expect(body).toMatch(/deliberate facet verdict/i);
    // evidence discipline: cite the source, never invent
    expect(body).toMatch(/cit(e|ation)/i);
    expect(body).toMatch(/never invent|do not invent/i);
  });

  it("interviews area-by-area, evidence-first, with an honest skip (ac-2: grounded, admin-gated)", async () => {
    tagAc(`${SPEC}/acs/ac-2`);
    const { body } = await fetchTopic("standards-bootstrap");
    expect(body).toMatch(/area/i);
    // an area that doesn't apply can be skipped (the honest denominator)
    expect(body).toMatch(/skip|not[- ]relevant|does(?:n't| not) apply/i);
    // acceptance is per-area, not one global rubber-stamp
    expect(body).toMatch(/per area|area by area/i);
    // saves only after a clear yes
    expect(body).toMatch(/only after a clear yes|clear yes/i);
  });

  it("stays portable per std-22 — no language / framework / path / tooling assumptions (ac-1)", async () => {
    tagAc(`${SPEC}/acs/ac-1`);
    const { body } = await fetchTopic("standards-bootstrap");
    // must not hardcode OUR repo layout, framework, package manager, or test runner
    const forbidden = [
      "packages/server",
      "packages/ui",
      "src/",
      "pnpm",
      "vitest",
      "npm test",
      "make test",
      "Hono",
      "Drizzle",
      "tagAc",
      "TypeScript",
      "React component",
    ];
    for (const token of forbidden) {
      expect(body, `portable protocol must not hardcode "${token}"`).not.toContain(token);
    }
    // it tells the agent to discover the stack rather than assume it
    expect(body).toMatch(/make no assumptions|discover (everything|it) from the project/i);
  });
});
