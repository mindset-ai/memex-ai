// spec-510 t-13 (dec-12 A) — the pointer names something that can actually
// answer (ac-25, ac-26).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WENT WRONG, so the guard is read as guarding something. The cadence
// replaces guidance with one line that says recovery is a call away. It named
// `get_information({ topic: 'phases' })` — a hand-authored topic of 6,521 chars
// containing NONE of the suppressed prose. 39% of the suppressed volume, the
// classify-and-consult tripwire included, had no retrieval path at all, on any
// tool in the manifest.
//
// ⚠ THE OBVIOUS GUARD WOULD NOT HAVE CAUGHT IT, which is why this file leads
// with content and not with names. Both of these pass against the code that
// carries the defect:
//
//     expect(CADENCE_POINTER).toContain("get_information")   // true then
//     expect(listTopics()).toContain("phases")               // true then
//
// The failure was never a missing topic. It was a topic that exists and covers
// none of what it stands in for. A guard that checks the slug closes L-8 on
// paper and leaves H-1 exactly where it was.
//
// SO THE LOAD-BEARING TEST IS "fetch what the pointer names, and assert it
// returns the blocks a real read suppresses". Everything else here supports it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  BASE_SCAFFOLD,
  cadencePointer,
  guidanceRecoverySlug,
  toGuidanceRecovery,
  toNudgeBlocks,
  type GuidanceBlock,
  type Phase,
} from "@memex/shared";
import { listTopics, fetchTopic } from "./guidance.js";

const AC_25 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-25";
const AC_26 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-26";

const PHASES: Phase[] = ["draft", "specify", "build", "verify", "done"];

/** The slug the pointer actually names, parsed out of the pointer rather than
 *  re-derived — so a pointer that drifted from the loader is caught here and not
 *  discovered by an agent. */
function slugNamedByPointer(phase: Phase): string {
  const m = cadencePointer(phase).match(/topic:\s*'([a-z0-9-]+)'/);
  if (!m) throw new Error(`pointer for '${phase}' names no topic: ${cadencePointer(phase)}`);
  return m[1];
}

describe("spec-510 — the recovery topic returns what the cadence took away (ac-26)", () => {
  it("every block a verbose read suppresses is retrievable through the topic the pointer names", async () => {
    tagAc(AC_26);
    // THE guard. For each phase: take what a real projection would suppress,
    // fetch the topic the pointer points at, and require every one of those
    // blocks to be in the body. This is the assertion that would have gone red
    // on the defect dec-12 was raised for.
    for (const phase of PHASES) {
      const suppressed = toNudgeBlocks({
        dataset: BASE_SCAFFOLD,
        tool: "get_doc",
        phase,
        grounding: "grounded",
      });
      expect(suppressed.length, `no blocks project for '${phase}' — fixture is wrong`).toBeGreaterThan(5);

      const body = (await fetchTopic(slugNamedByPointer(phase))).body;

      const missing = suppressed.filter((b) => !body.includes(b.text)).map((b) => b.id);
      expect(
        missing,
        `The pointer shown in '${phase}' names a topic that cannot return these ` +
          `blocks:\n  ${missing.join("\n  ")}\n\nThat is the defect dec-12 exists ` +
          `to fix: an agent is told recovery is one call away and the call returns ` +
          `something else.`,
      ).toEqual([]);
    }
  });

  it("the topic is PROPORTIONATE to what was lost, not the whole Scaffold", async () => {
    tagAc(AC_26);
    // Why phase-scoped rather than one topic. The whole-Scaffold projection is
    // 38,037 chars against the ~10,755 a build read suppresses — an agent that
    // fetched it twice would have spent more than the cadence ever saved, and the
    // Spec would be net negative for the reader it is meant to help.
    for (const phase of PHASES) {
      const suppressed = toNudgeBlocks({
        dataset: BASE_SCAFFOLD,
        tool: "get_doc",
        phase,
        grounding: "grounded",
      }).reduce((a, b) => a + b.text.length, 0);
      const body = (await fetchTopic(slugNamedByPointer(phase))).body;

      expect(body.length).toBeGreaterThanOrEqual(suppressed);
      expect(
        body.length / suppressed,
        `Recovery for '${phase}' costs ${(body.length / suppressed).toFixed(2)}x what ` +
          `was suppressed. Past ~2x the pointer stops being a saving and becomes a ` +
          `bill — re-scope the projection rather than raising this bound.`,
      ).toBeLessThan(2);
    }
  });
});

describe("spec-510 — the recovery topic is DERIVED, not curated (ac-25)", () => {
  it("a block added to the dataset appears in the projection with no other edit", () => {
    tagAc(AC_25);
    // The property that makes A worth its cost over B. If this projection were a
    // hand-written file plus a maintained list of what it covers, the list would
    // pass the day it was written and drift silently after — the exact staleness
    // that produced the original defect.
    const invented: GuidanceBlock = {
      kind: "guidance_block",
      id: "derived-probe",
      source: "base",
      target: { phase: "build" },
      text: "DERIVED PROBE BODY — invented by a test, never authored anywhere.",
      enabled: true,
      order: 99,
      rationale: "probe",
    };
    const dataset = {
      ...BASE_SCAFFOLD,
      baseGuidance: [...BASE_SCAFFOLD.baseGuidance, invented],
    };

    expect(
      toGuidanceRecovery(dataset, "build"),
      "A block added to the Scaffold did not reach the recovery projection. The " +
        "projection is not derived from the block set, so recovery will drift " +
        "from suppression exactly as it did before dec-12.",
    ).toContain(invented.text);

    // …and it does NOT leak into another phase's topic, or the projection would
    // be "everything" wearing a phase's name.
    expect(toGuidanceRecovery(dataset, "verify")).not.toContain(invented.text);
  });

  it("the index and the fetch agree — every generated slug resolves", async () => {
    tagAc(AC_25);
    // `listTopics` and `fetchTopic` read one registry. A slug in the index that
    // 404s on fetch is indistinguishable, to an agent, from the defect this Spec
    // fixes: it followed the pointer and got nothing.
    const listed = (await listTopics()).map((t) => t.topic);
    for (const phase of PHASES) {
      const slug = guidanceRecoverySlug(phase);
      expect(listed, `'${slug}' is fetchable but absent from the index`).toContain(slug);
      await expect(fetchTopic(slug)).resolves.toMatchObject({ topic: slug });
    }
  });

  it("no generated slug collides with a hand-authored topic file", async () => {
    tagAc(AC_25);
    // The registry wins on fetch, so a colliding file would be silently shadowed
    // — its author would edit a file that no longer serves anything. Asserted
    // rather than resolved by precedence.
    const listed = (await listTopics()).map((t) => t.topic);
    const dupes = listed.filter((s, i) => listed.indexOf(s) !== i);
    expect(dupes, `these slugs exist as BOTH a file and a generated topic: ${dupes}`).toEqual([]);
  });

  it("the recovery surface is UNGATED — it ships on merge, with both flags off", async () => {
    tagAc(AC_25);
    // ⚠ THIS IS THE ONE THING SPEC-510 CHANGES FOR EVERYONE ON MERGE DAY, and
    // the PR originally claimed the opposite: "both flags default OFF, so
    // merging changes nothing in production" (PR #740 round-13, N-21).
    //
    // `GENERATED_TOPICS` references no flag. With the cadence off and the shared
    // store off, every agent's `get_information` index still gains five entries
    // — measured at 1,034 characters — and `get_information({topic:
    // 'guidance-build'})` returns a 12,829-char body that did not exist before.
    //
    // THAT IS DELIBERATE, not an oversight. Gating the topics would ship a
    // pointer whose target is switched off, which is strictly worse: the agent
    // would be told where to look and find nothing, which is the defect dec-12
    // was raised to fix. The flags gate SUPPRESSION; the recovery surface is
    // inert until something points at it.
    //
    // Asserted rather than described, because "the flags make this a zero-risk
    // merge" is the sentence a reviewer decides on, and it is now false in a
    // specific and measurable way.
    const previousCadence = process.env.GUIDANCE_CADENCE_ENABLED;
    const previousStore = process.env.HANDOFF_SHARED_STORE_ENABLED;
    delete process.env.GUIDANCE_CADENCE_ENABLED;
    delete process.env.HANDOFF_SHARED_STORE_ENABLED;
    try {
      const listed = (await listTopics()).map((t) => t.topic);
      for (const phase of PHASES) {
        const slug = guidanceRecoverySlug(phase);
        expect(
          listed,
          `'${slug}' vanished when the flags went off. The recovery surface must ` +
            `NOT be gated — a pointer whose target is switched off sends an agent ` +
            `somewhere empty, which is the defect dec-12 exists to fix.`,
        ).toContain(slug);
        await expect(fetchTopic(slug)).resolves.toMatchObject({ topic: slug });
      }
    } finally {
      if (previousCadence === undefined) delete process.env.GUIDANCE_CADENCE_ENABLED;
      else process.env.GUIDANCE_CADENCE_ENABLED = previousCadence;
      if (previousStore === undefined) delete process.env.HANDOFF_SHARED_STORE_ENABLED;
      else process.env.HANDOFF_SHARED_STORE_ENABLED = previousStore;
    }
  });

  it("the pointer names a slug the loader actually serves (L-8)", async () => {
    tagAc(AC_26);
    // Kept deliberately LAST and called out as the weak one: this is the
    // assertion that passes against the defect. It catches a typo or a renamed
    // topic; it does not catch an empty one. The content test above is the guard.
    const listed = (await listTopics()).map((t) => t.topic);
    for (const phase of PHASES) {
      expect(cadencePointer(phase)).toContain("get_information");
      expect(listed).toContain(slugNamedByPointer(phase));
    }
  });
});
