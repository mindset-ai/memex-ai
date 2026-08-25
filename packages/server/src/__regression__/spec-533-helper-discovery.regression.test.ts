// spec-533 t-1 — the discovery gate states a rule AND supplies the facts to
// evaluate it, and it stops telling every reader that the helper doesn't apply
// to them.
//
// THREE DEFECTS, ALL IN PROSE, ALL SILENT.
//
//   1. The gate says "prefer an official helper if one exists for your stack"
//      and never says which ones exist. The agent holds a conditional it
//      cannot evaluate, so it evaluates it to "no".
//   2. It points at `<server>/docs/examples/`, which 404s. There is no static
//      mount for `docs/` and none is being added — the table lives in the
//      guidance instead, so there is no pointer left to follow (dec-1).
//   3. Worst: the body opens by asserting the reader has no helper — and
//      `provision_ac_emission` serves this body UNCONDITIONALLY, to every
//      repo. So the agent finds the package's exact name inside a sentence
//      saying it is unavailable to it. Four consistent messages, all wrong
//      for a Vitest repo.
//
// dec-5 supersedes spec-234 dec-2 for covered stacks only: where a helper
// exists, installing it is the expected path. What spec-234 was protecting —
// nobody is stranded — survives untouched, and ac-10 pins that.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const M = "mindset-prod/memex-building-itself/specs/spec-533/acs";
const AC_7 = `${M}/ac-7`; // table served in the guidance, single-sourced
const AC_8 = `${M}/ac-8`; // dead pointer gone; opening presupposes nothing
const AC_9 = `${M}/ac-9`; // the no-install claim replaced by the conditional rule
const AC_10 = `${M}/ac-10`; // an unshipped stack still emits with nothing installed
const AC_1 = `${M}/ac-1`; // SCOPE: the gate finds the helper when one exists

const GUIDANCE = join(__dirname, "..", "guidance");

function topic(name: string): { title: string; when_to_read: string; body: string } {
  return JSON.parse(
    readFileSync(join(GUIDANCE, `${name}.json`), "utf-8"),
  ) as { title: string; when_to_read: string; body: string };
}

const bootstrap = topic("ac-emission-bootstrap");

describe("spec-533 t-1: the helper table is served, the dead pointer is gone", () => {
  it("names the official helper with its install command [ac-7][ac-1]", () => {
    tagAc(AC_7);
    // ac-1 is the scope commitment this half delivers: the gate FINDS the
    // helper when one exists. Tagged here because this assertion is the
    // "finds it" half — the "no false negative" half is below.
    tagAc(AC_1);
    // The rule already existed; the FACTS did not. An agent must be able to
    // answer "does a helper exist for my stack?" from this body alone.
    expect(bootstrap.body).toMatch(/npm install --save-dev @memex-ai-ac\/vitest/);
    expect(bootstrap.body).toMatch(/@memex-ai-ac\/vitest\/setup/);
  });

  it("carries NO version pin on the install line, so it resolves to latest [ac-7]", () => {
    tagAc(AC_7);
    // A pin is how a consumer gets frozen on 0.2.0 — the very defect this
    // Spec exists to stop manufacturing. Whoever installs today must land on
    // a version that batches, and stay correct by moving a range later.
    expect(bootstrap.body).not.toMatch(/@memex-ai-ac\/vitest@\d/);
  });

  it("states that installing is EXPECTED where a helper exists, not optional [ac-7]", () => {
    tagAc(AC_7);
    // dec-5. "Optional accelerator" (spec-234 dec-2) is superseded for
    // covered stacks: a hand-rolled emitter has no version to bump, so no
    // correction we ship can ever reach it.
    expect(bootstrap.body).toMatch(/expected path/i);
  });

  it("contains no `docs/examples/` pointer [ac-8]", () => {
    tagAc(AC_8);
    // Verified 404 on 2026-08-20: 301 → www.memex.ai → 404. A pointer an
    // agent cannot follow is worse than none, because it converts "I should
    // look for a helper" into "I looked, there is none".
    expect(bootstrap.body).not.toMatch(/docs\/examples/);
  });

  it("does not open by asserting the reader has no helper [ac-8][ac-1]", () => {
    tagAc(AC_8);
    // The other half of ac-1: no path that answers "no helper exists" when one
    // does. This sentence WAS that path — served unconditionally, to everyone.
    tagAc(AC_1);
    // This body is served unconditionally to EVERY repo, so its opening
    // cannot presuppose a stack it has not detected. The agent does the
    // detection — it is the only party that can see the repo (std-22).
    const opening = bootstrap.body.slice(0, 600);
    expect(opening).not.toMatch(/you can't `?npm install/i);
    expect(opening).not.toMatch(/your codebase has no official/i);
  });

  it("directs the reader to check the table before hand-rolling [ac-8]", () => {
    tagAc(AC_8);
    // Replaces the dead pointer with something reachable from where the
    // agent stands: text it is already reading.
    expect(bootstrap.body.slice(0, 900)).toMatch(/below|table/i);
  });

  it("still tells an unshipped stack to hand-roll, and keeps the whole protocol [ac-10]", () => {
    tagAc(AC_10);
    // spec-234's load-bearing property: nobody is stranded. The supersession
    // is scoped to covered stacks; every other stack still gets the full
    // protocol and can emit with nothing installed.
    expect(bootstrap.body).toMatch(/hand-roll/i);
    // The behavioural contract that spec-525 added on 2026-08-12 must survive
    // this edit — batching, the 404/405-only fallback, and its bounds.
    expect(bootstrap.body).toMatch(/build against the batched one/i);
    expect(bootstrap.body).toMatch(/Do not build that/i);
    expect(bootstrap.body).toMatch(/api\/test-events\/batch/);
    expect(bootstrap.body).toMatch(/404.*405|405.*404/);
    // Item 7 — the whole reason half B can reach a hand-rolled emitter.
    expect(bootstrap.body).toMatch(/X-Memex-Warning/);
  });
});

describe("spec-533 t-1: the tool's own copy no longer contradicts the rule", () => {
  // Asserted against the source strings rather than a rendered call, on purpose:
  // an ephemeral emission key is scoped to ONE Spec, so tagging spec-533 ACs
  // inside the spec-234 integration file would silently fail to land one of the
  // two sets. The rendered-output assertions live there under spec-234's own
  // handles; these are spec-533's.
  const acs = readFileSync(
    join(__dirname, "..", "agent", "handlers", "acs.ts"),
    "utf-8",
  );

  it("neither the tool description nor the rendered §2 claims no install is required [ac-9]", () => {
    tagAc(AC_9);
    // Two sites, both of which told every repo the opposite of the rule the
    // same response states. This is the sentence spec-234 dec-2 put there
    // deliberately, and dec-5 supersedes for covered stacks only.
    expect(acs).not.toMatch(/no package install/i);
    expect(acs).not.toMatch(/no install step is required/i);
  });

  it("the tool description carries no handle from THIS Memex [ac-9]", () => {
    tagAc(AC_9);
    // Caught during this task: the first draft wrote "(spec-533 dec-5)" into the
    // description, which is served to every customer's agent. std-22 bars a
    // literal `std-N` for exactly this reason — a handle from our Memex means
    // nothing in someone else's workspace — and a `spec-N`/`dec-N` handle is the
    // same category error. The existing portability guard
    // (spec-234-ac-emission-guidance) only scans the *provisioning section* of a
    // guidance body, so it does not cover tool descriptions at all. This closes
    // that hole for this tool.
    const desc = acs.slice(
      acs.indexOf('name: "provision_ac_emission"'),
      acs.indexOf("schema: {", acs.indexOf('name: "provision_ac_emission"')),
    );
    expect(desc.length).toBeGreaterThan(200); // the slice actually found the block
    expect(desc).not.toMatch(/\b(spec|std|dec|doc|ac)-\d+/i);
  });

  it("both sites state the conditional rule instead [ac-9]", () => {
    tagAc(AC_9);
    // The rule was already correct and already delegated to the agent — it is
    // the only party that can see the repo. What was missing was the fact that
    // makes the condition evaluable, and a posture that does not undercut it.
    expect(acs).toMatch(/expected path/i);
    expect(acs).toMatch(/detect the test runner/i);
    // And the reason, so the next reader does not "simplify" it back.
    expect(acs).toMatch(/no version to bump/i);
  });
});

describe("spec-533 t-1: no static mount is added for docs/", () => {
  it("the server serves no `docs/` path [ac-8]", () => {
    tagAc(AC_8);
    // dec-1 chose to serve the table in the guidance precisely so that no
    // path has to exist. If one ever appears, the fix has drifted back into
    // "something that can 404".
    const app = readFileSync(join(__dirname, "..", "app.ts"), "utf-8");
    expect(app).not.toMatch(/docs\/examples/);
    expect(app).not.toMatch(/serveStatic[^)]*docs/);
  });
});
