// spec-161 follow-up (interim): the `authoring-standards` get_information topic.
// A Claude Code creating a standard is pointed here by the create_doc nudge, so this
// topic must (a) load and appear in the index, and (b) actually teach the clause model
// + the full tool flow. Guards against the file being deleted or hollowed out.

import { describe, it, expect } from "vitest";
import { listTopics, fetchTopic } from "../services/guidance.js";

describe("authoring-standards guidance topic", () => {
  it("appears in the topic index", async () => {
    const topics = await listTopics();
    const slugs = topics.map((t) => t.topic);
    expect(slugs).toContain("authoring-standards");
    const entry = topics.find((t) => t.topic === "authoring-standards")!;
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.whenToRead.length).toBeGreaterThan(0);
  });

  it("teaches the clause model and what 'good' looks like", async () => {
    const { body } = await fetchTopic("authoring-standards");
    expect(body).toMatch(/clause/i);
    expect(body).toMatch(/one aspect|one self-contained aspect/i);
    // section conventions named (house vocabulary: Rule / Rationale / Scope)
    expect(body).toMatch(/Rule/);
    expect(body).toMatch(/Rationale/);
    expect(body).toMatch(/Scope/);
  });

  it("prescribes the multi-section shape (Rule + Rationale + Scope), not a bare Rule", async () => {
    const { body } = await fetchTopic("authoring-standards");
    // explicitly warns against collapsing a standard to a single Rule section —
    // the gap the std-1..std-8 distillation exposed (every standard came out as one Rule section).
    expect(body).toMatch(/do not collapse|bare Rule/i);
    // names the why/where sections a distilled standard should carry
    expect(body).toMatch(/Rationale/);
    expect(body).toMatch(/Scope/);
    // points at the canonical reference standard to copy the shape from
    expect(body).toMatch(/memex-building-itself\/std-1/);
    // the worked example authors more than one section, including rationale + scope
    expect((body.match(/add_section/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/sectionType:\s*"rationale"/);
    expect(body).toMatch(/sectionType:\s*"scope"/);
  });

  it("walks the full clause tool flow with a worked example", async () => {
    const { body } = await fetchTopic("authoring-standards");
    for (const tool of ["create_doc", "add_section", "get_doc", "add_clause", "edit_clause", "delete_clause"]) {
      expect(body, `body should mention ${tool}`).toContain(tool);
    }
    // the example shows clauses[] authoring + that prose content is rejected
    expect(body).toMatch(/clauses:\s*\[/);
    expect(body).toMatch(/content.*reject|reject.*content/i);
  });

  it("guides distilling standards from an existing codebase (the onboarding use case)", async () => {
    const { body } = await fetchTopic("authoring-standards");
    // names the rule sources, in particular CLAUDE.md, the memory file, READMEs, the code
    for (const src of ["CLAUDE.md", "memory", "README", "codebase"]) {
      expect(body, `should point at ${src}`).toMatch(new RegExp(src.replace(".", "\\."), "i"));
    }
    expect(body).toMatch(/distilling|craft/i);
    // the turn-findings-into-standards discipline
    expect(body).toMatch(/group by theme/i);
    expect(body).toMatch(/confirm before|do(?:n't| not) invent/i);
  });

  it("the topic's when_to_read signals the codebase-distillation trigger (index discoverability)", async () => {
    const entry = (await listTopics()).find((t) => t.topic === "authoring-standards")!;
    expect(entry.whenToRead).toMatch(/codebase|craft|distil/i);
  });
});
