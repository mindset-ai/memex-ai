// spec-551 t-2 (dec-2) — the std-22 portability guard over the surfaces that reach a
// reader in someone else's Memex: the scaffold prose, the get_information bodies, and
// the live MCP tool contract.
//
// The sibling of default-standards.portability.test.ts and default-facets.portability
// .test.ts, sharing their deny-list via ./portability-scan.ts. Those two guard what is
// seeded INTO a Memex once; this guards what is sent to one on every call — the surface
// std-22 cl-32/cl-35 name and cl-60 records as having no automated guard at all.
//
// SCOPED TO THE WHOLE CORPUS, not the strings spec-551 edits. A check that only looked
// at today's eight defects would wave through the ninth.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { collectPortableSurface } from "./portable-surface.js";
import * as scanModule from "./portability-scan.js";
import {
  canarySamplesNotFlagged,
  scanForEntityHandles,
  scanForNonPortableTokens,
  type Scannable,
} from "./portability-scan.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-551/acs/ac-${n}`;

describe("spec-551: the portable surface carries no unresolvable citation", () => {
  it("flags every entity-handle class, not only std-N (ac-7)", () => {
    tagAc(AC(7));
    // dec-2: cl-19's letter covers Standards only, which would leave the transition
    // rubrics and the guidance bodies — where the `dec-N` and `spec-N` citations live —
    // entirely unguarded. Those are the worst instances in the inventory: a bare dec-N
    // is scoped to its Spec, so it resolves in NO Memex, this one included.
    const classes = ["std-18", "spec-449", "dec-11", "ac-7", "cl-19", "t-4", "doc-6"];
    const items: Scannable[] = classes.map((handle) => ({
      where: `synthetic:${handle}`,
      text: `the rule is stated in ${handle} and you should follow it`,
    }));

    const flagged = scanForEntityHandles(items).map((v) => v.match(/matched "([^"]+)"/)?.[1]);

    expect(flagged.sort()).toEqual([...classes].sort());
  });

  it("reports one violation per occurrence, not one per string (ac-8)", () => {
    tagAc(AC(8));
    // The first-match-only behaviour this replaced would have reported ONE of these
    // three. You would fix the handle it named, the scan would go green, and two would
    // ship — a silent partial success, which is the defect class this Spec exists to
    // close. It must not survive inside this Spec's own guard.
    const items: Scannable[] = [
      {
        where: "synthetic:three-in-one-string",
        text: "follow std-18, as decided in dec-11, and see the note in spec-449 for context",
      },
    ];

    const violations = scanForEntityHandles(items);
    const handles = violations.map((v) => v.match(/matched "([^"]+)"/)?.[1]).sort();

    expect(handles).toEqual(["dec-11", "spec-449", "std-18"]);
  });

  it("keeps a known-bad sample per adapter shape, so the guard can still fail (ac-15, ac-4)", () => {
    tagAc(AC(15));
    tagAc(AC(4));
    // Guards the guard. The pre-existing samples are clause-sized; a walk that stopped
    // enumerating the scaffold or the tool contract would not have disturbed them.
    expect(canarySamplesNotFlagged()).toEqual([]);
  });

  it("does not flag the de-numbered placeholder form (ac-11)", () => {
    tagAc(AC(11));
    // dec-3 replaced every demonstration's number with `<N>`. If that form still
    // tripped the deny-list, the sweep would have quietly converted dec-3 into the
    // exemption-list option it rejected — the corpus would only look clean because
    // someone had told the guard to look away. Asserted against the pattern itself,
    // never inferred from a green run over the corpus.
    const items: Scannable[] = [
      { where: "synthetic:ref", text: "e.g. `mindset/main/specs/spec-N/tasks/t-N`" },
      { where: "synthetic:handles", text: "Reference elements by their handle: `dec-N`, `t-N`, `s-N`." },
      { where: "synthetic:clauses", text: "creates section `s-N` with clauses `cl-N, cl-N+1, cl-N+2`" },
      { where: "synthetic:standard", text: "e.g. `<ns>/<mx>/standards/std-N/clauses/cl-N`" },
    ];

    expect(scanForEntityHandles(items)).toEqual([]);
  });

  it("scans through a rule GROUP declared in the module, not a caller-built subset (ac-26)", () => {
    tagAc(AC(26));
    // dec-6. The narrow scan must be a NAMED group inside the module — the module's
    // header forbids a caller reaching the raw deny-list, because a caller that can
    // pick rules eventually drops the inconvenient ones and the fixtures relying on
    // the list drift apart. So: two entry points, and no way to compose a third.
    const surface = Object.keys(scanModule).sort();
    expect(surface).toEqual([
      "canarySamplesNotFlagged",
      "scanForEntityHandles",
      "scanForNonPortableTokens",
    ]);

    // The wide scan still sees what the narrow one ignores, so nothing already
    // enforced was weakened by adding the group.
    const nonHandle: Scannable[] = [
      { where: "synthetic:tooling", text: "run pnpm vitest against the suite" },
    ];
    expect(scanForNonPortableTokens(nonHandle).length).toBeGreaterThan(0);
    expect(scanForEntityHandles(nonHandle)).toEqual([]);
  });

  it("is wired into a gate that runs before a push, not merely available (ac-3)", async () => {
    tagAc(AC(3));
    // The rule is only a gate if something runs it. Two lanes, both asserted from the
    // files that do the running — a guard nobody invokes is a guard that protects
    // nothing, and that was the state std-22 cl-60 recorded for two Specs.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const makefile = await readFile(join(repoRoot, "Makefile"), "utf8");
    const prePush = await readFile(join(repoRoot, ".husky", "pre-push"), "utf8");

    // Offline lane: part of the `check` target, not an orphan target nobody calls.
    expect(makefile).toMatch(/^check:.*check-portable-surface/m);
    expect(makefile).toContain("scripts/check-portable-surface.ts");
    // Suite lane: pre-push runs the server unit tier, and this file lives in it
    // (no `.integration.`/`.regression.`/etc. suffix, so test:unit's excludes miss it).
    expect(prePush).toContain("test:unit");
  });

  it("finds no handle literal anywhere on the rendered surface (ac-10)", async () => {
    tagAc(AC(10));
    // The whole point. Every string the product sends to a reader in a Memex we do not
    // control — scaffold prose, guidance topic bodies, MCP tool and argument
    // descriptions — asserted in one place.
    const corpus = await collectPortableSurface();
    const violations = scanForEntityHandles(corpus);

    expect(
      violations,
      `The portable surface cites handles that do not resolve where they are shown:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
