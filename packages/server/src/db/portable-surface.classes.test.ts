// spec-551 t-4 / t-5 — the per-class repairs, asserted POSITIVELY.
//
// The corpus guard proves a negative: no bare handle survives anywhere. That is
// necessary and not sufficient. Deleting the whole sentence would also satisfy it,
// and so would replacing a citation with the wrong remedy. dec-1 chose a different
// remedy per class, and each class made a promise about what the reader gets INSTEAD
// — that is what these assert.
//
// Kept separate from portable-surface.portability.test.ts on purpose: that file
// enforces one rule over everything and must stay indifferent to which strings exist;
// this one names specific sites and will rightly need editing when they change.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_SCAFFOLD,
  SPEC_SHAPE_MISSING_LENS_WARNING,
  SKILLS_AGENT_GUIDANCE,
  SKILLS_AGENT_MODE_GUIDANCE,
  toRubric,
} from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-551/acs/ac-${n}`;

const QUALIFIED = "mindset-prod/memex-building-itself/standards";
const lensBlock = () =>
  BASE_SCAFFOLD.promptBlocks.find((b) => b.id === "spec-shape-lenses")?.text ?? "";

describe("spec-551: each class got the remedy its kind needed (dec-1)", () => {
  it("class A — the lens prose points the reader at their OWN Standards, conditionally (ac-16)", () => {
    tagAc(AC(16));
    const text = lensBlock();

    // The pointer, not just the absence of a number.
    expect(text).toContain("search_memex");
    // Conditional, and that is load-bearing rather than hedging: the default-Standards
    // seed reaches PERSONAL Memexes only, so a customer's team Memex normally holds
    // no Spec-shape Standard at all.
    expect(text.toLowerCase()).toContain("if this memex has a standard on spec shape");
    expect(text.toLowerCase()).toContain("default where it has none");
    // And the claim that used to be false — "does not re-list the taxonomy" — is gone,
    // while the taxonomy it always carried stays.
    expect(text).not.toContain("rather than re-listing");
    expect(text).toContain("Architecture & Security");
  });

  it("class A — the missing-lens nudge states the rule and gets no heavier (ac-16)", () => {
    tagAc(AC(16));
    // A soft signal that never blocks a transition must not start reading like a
    // procedure. MEASURED, not guessed: 652 chars before this Spec, 656 after — the
    // first rewrite came in at 664 and was trimmed, because dec-1 promised "no added
    // length" and a 12-character overrun is still a broken promise. The ceiling holds
    // a future edit to that promise rather than pinning the wording.
    expect(SPEC_SHAPE_MISSING_LENS_WARNING.length).toBeLessThanOrEqual(660);
    expect(SPEC_SHAPE_MISSING_LENS_WARNING).toContain("Three core lenses");
    expect(SPEC_SHAPE_MISSING_LENS_WARNING).toContain('"n/a"');
    // No search pointer here: the reader already has the rule in front of them.
    expect(SPEC_SHAPE_MISSING_LENS_WARNING).not.toContain("search_memex");
  });

  it("class C — both rubrics still state their rule in full, minus the provenance (ac-17)", () => {
    tagAc(AC(17));
    const build = toRubric({ dataset: BASE_SCAFFOLD, transition: "build", orgBlocks: [] });
    const done = toRubric({ dataset: BASE_SCAFFOLD, transition: "done", orgBlocks: [] });

    // The rule survives verbatim; only the unresolvable attribution left.
    expect(build).toContain("## Narrative consolidation (mandatory)");
    expect(done).toContain("Done requires: all task acceptance criteria checked off");
    // And the mandate is not softened — "mandatory" and the hold consequence remain.
    expect(build).toContain("the verdict is `hold`");
  });

  it("class B — our own rules are cited in full, and the repeat is dropped (ac-19)", () => {
    tagAc(AC(19));
    // Rules about Memex's own behaviour. A customer's Memex will never hold them, so
    // "search your Standards" would point at a void — qualification is the honest
    // remedy, and it resolves because this Memex is readable from every account.
    expect(SKILLS_AGENT_GUIDANCE.text).toContain(`${QUALIFIED}/std-34`);
    expect(SKILLS_AGENT_MODE_GUIDANCE.text).toContain(`${QUALIFIED}/std-34`);

    // Style rule: qualify the FIRST mention in a string, drop a repeat within it.
    // Three 60-character refs in one prompt block is noise, and the second attributes
    // a rule the reader met four lines earlier.
    const qualifiedMentions = (SKILLS_AGENT_MODE_GUIDANCE.text.match(/standards\/std-34/g) ?? [])
      .length;
    expect(qualifiedMentions).toBe(1);
    expect(SKILLS_AGENT_MODE_GUIDANCE.text).toContain("Honest handoff over faked action.");
  });

  it("class B — the length-bounded summary states the rule, the roomy description cites it (ac-19)", async () => {
    tagAc(AC(19));
    const registerIssue = BASE_SCAFFOLD.tools.find((t) => t.name === "register_issue");
    expect(registerIssue).toBeDefined();

    // The manifest summary is capped at 240 chars and sat at 205; the qualified form
    // would be 248. So this surface states the rule instead of citing it — dec-1's
    // pre-written branch for a site where qualification does not fit.
    expect(registerIssue!.summary).toContain("no silent default home");
    expect(registerIssue!.summary.length).toBeLessThanOrEqual(240);

    // The handler description has no such bound, so it carries the citation.
    const handler = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "handlers", "issues.ts"),
      "utf8",
    );
    expect(handler).toContain(`${QUALIFIED}/std-5`);
    // And the runtime refusal STATES the rule rather than footnoting a ref into an
    // error path nobody follows.
    expect(handler).toContain("an Issue is never persisted without a home.");
  });

  it("class D — the anecdote keeps its cause and effect, and the version marker stays (ac-18)", async () => {
    tagAc(AC(18));
    const guidanceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "guidance");
    const orphans = await readFile(join(guidanceDir, "orphaned-test-events.json"), "utf8");
    const emission = await readFile(join(guidanceDir, "ac-emission.json"), "utf8");

    // Naming no Spec must not cost the explanation. Cause and effect both survive.
    expect(orphans).toContain("combined test was split into three");
    expect(orphans).toContain("pinned that AC red for days");
    // A version is not a handle.
    expect(emission).toContain("(v0.1.0)");
  });

  it("the lens test asserts properties, and its title matches what it tags (ac-21, ac-23)", async () => {
    tagAc(AC(21));
    tagAc(AC(23));
    // dec-4: what was retired is the pin on a literal phrase. Asserted by reading the
    // test file, because the claim is about how that test is written.
    const lensTest = await readFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "..", "..", "shared", "src", "scaffold-data.spec-shape-lenses.test.ts",
      ),
      "utf8",
    );

    // Comments stripped first. The claim is about what the test EXECUTES, and the
    // rewritten test's own comment quotes both retired assertions to explain what was
    // retired — as it should. Asserting over the prose would forbid the explanation.
    const executed = lensTest
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

    expect(executed).not.toContain("std-18 is the source of truth");
    expect(executed).not.toContain('toContain("std-18")');
    // Its title and its emissions now name the same criteria — the old version's title
    // said "(ac-5)" while it tagged only ac-11.
    expect(lensTest).toContain("tagAc(AC(5))");
  });
});
