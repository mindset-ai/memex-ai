// spec-551 t-9 — the closing proof, taken on the COMPOSED output rather than the
// source strings.
//
// The corpus guard (portable-surface.portability.test.ts) scans the strings we author.
// This scans what a reader actually receives after they have been through the
// projections — `toRubric` for each phase transition, `toNudge` for the footer,
// `toPhaseGuidance` for the system prompt, `toToolDefinition` for the MCP contract,
// and each `get_information` topic as the server reads it.
//
// Why both. A clean source can still compose dirty: a projection that interpolates a
// handle, joins in a block the corpus walk does not reach, or renders a field nobody
// enumerated would pass the corpus guard and fail a reader. The defect this Spec came
// from was found by reading a RESPONSE, not a file, so the closing check reads
// responses too.
//
// WHAT THIS CANNOT DO. The original report came from calling `assess_spec` against a
// live Memex, and that path runs through the DEPLOYED server. Until this change ships,
// a live call still returns the old prose. This test is the local equivalent — the
// same functions, the same composition, one process earlier. The live replay against a
// Memex holding no `std-18`, on all four phase targets, belongs to post-deploy
// verification [per std-17] and is named in the QA report as such rather than being
// quietly counted as done here.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  BASE_SCAFFOLD,
  SPEC_SHAPE_MISSING_LENS_WARNING,
  toNudge,
  toPhaseGuidance,
  toRubric,
  toToolDefinition,
} from "@memex/shared";
import { listTopics, fetchTopic } from "../services/guidance.js";
import { scanForEntityHandles, type Scannable } from "./portability-scan.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-551/acs/ac-${n}`;

const PHASES = ["draft", "specify", "build", "verify", "done"] as const;
const TRANSITIONS = ["specify", "build", "verify", "done"] as const;

describe("spec-551: the composed output carries no unresolvable citation", () => {
  it("every phase transition's rubric is clean — all four targets, not just build (ac-2)", () => {
    tagAc(AC(2));
    // The original report exercised `target: 'build'` only. `done` turned out to
    // carry its own bare handle (`dec-2`), found only because this Spec went looking.
    // Absence of a reading is not a clean reading, so all four are asserted.
    const items: Scannable[] = TRANSITIONS.map((transition) => ({
      where: `rubric:${transition}`,
      text: toRubric({ dataset: BASE_SCAFFOLD, transition, orgBlocks: [] }),
    }));

    // Each rubric must actually have composed: measured 1,075 / 4,792 / 2,676 / 2,733
    // chars today, so 500 is a floor that catches an empty projection without
    // pinning the prose length.
    for (const item of items) expect(item.text.length, item.where).toBeGreaterThan(500);

    const violations = scanForEntityHandles(items);
    expect(violations, `Rubric prose still cites handles:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the missing-core-lens nudge — the string in the original report — is clean (ac-2)", () => {
    tagAc(AC(2));
    // Interpolated the way `phase-assessment` interpolates it, so the substitution
    // itself cannot smuggle one back in.
    const items: Scannable[] = [
      {
        where: "nudge:missing-core-lens",
        text: SPEC_SHAPE_MISSING_LENS_WARNING.replace(
          "{lens}",
          "Design & UX, Architecture & Security",
        ),
      },
    ];

    expect(scanForEntityHandles(items)).toEqual([]);
  });

  it("the footer nudge and the system prompt are clean for every phase (ac-1)", () => {
    tagAc(AC(1));
    const items: Scannable[] = [];
    for (const phase of PHASES) {
      items.push({
        where: `phase-guidance:${phase}`,
        text: toPhaseGuidance(BASE_SCAFFOLD, phase),
      });
      // A representative spread of tools rather than one: the footer is composed per
      // (tool, phase), so a block that only matches some pairs would hide behind a
      // single-tool check.
      for (const tool of ["get_doc", "create_task", "assess_spec", "register_issue"]) {
        items.push({
          where: `nudge:${tool}@${phase}`,
          text: toNudge({ dataset: BASE_SCAFFOLD, tool, phase, orgBlocks: [] }),
        });
      }
    }

    for (const item of items) expect(item.text.length, item.where).toBeGreaterThan(200);

    const violations = scanForEntityHandles(items);
    expect(violations, `Composed guidance still cites handles:\n${violations.join("\n")}`).toEqual(
      [],
    );
  });

  it("every registered tool's MCP definition is clean (ac-1)", () => {
    tagAc(AC(1));
    // `toToolDefinition` is what the client actually receives — the same mapping that
    // carried the `std-5` citation confirmed in a live client's loaded schema.
    const items: Scannable[] = BASE_SCAFFOLD.tools.flatMap((tool) => {
      const definition = toToolDefinition(tool);
      return [{ where: `tool-definition:${definition.name}`, text: definition.description }];
    });

    expect(items.length).toBeGreaterThan(50);
    for (const item of items) expect(item.text.length, item.where).toBeGreaterThan(20);

    const violations = scanForEntityHandles(items);
    expect(violations, `Tool definitions still cite handles:\n${violations.join("\n")}`).toEqual([]);
  });

  it("every get_information topic is clean as the server reads it (ac-1)", async () => {
    tagAc(AC(1));
    // Through `fetchTopic`, not by re-reading the JSON: this is the path an agent's
    // `get_information` call takes, and it is where the two provenance citations
    // (`spec-115 dec-6`, `spec-122`) were hiding behind the first-match-only scan.
    const topics = await listTopics();
    expect(topics.length).toBeGreaterThan(0);

    const items: Scannable[] = [];
    for (const { topic } of topics) {
      const loaded = await fetchTopic(topic);
      items.push({ where: `topic:${topic} / body`, text: loaded.body });
      if (loaded.title) items.push({ where: `topic:${topic} / title`, text: loaded.title });
    }

    for (const item of items) expect(item.text.length, item.where).toBeGreaterThan(20);

    const violations = scanForEntityHandles(items);
    expect(violations, `Guidance topics still cite handles:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the demonstrations still read as usable examples (ac-5)", () => {
    tagAc(AC(5));
    // De-numbering must not have destroyed what the examples teach. The ref-grammar
    // example still shows a full path with every segment, and the handle demo still
    // shows the three same-doc forms — only the digits are gone.
    const mutationProtocol = BASE_SCAFFOLD.baseGuidance
      .map((b) => b.text)
      .join("\n");

    expect(mutationProtocol).toContain("mindset/main/specs/spec-N");
    expect(mutationProtocol).toMatch(/dec-N.*t-N.*s-N/s);
  });
});
