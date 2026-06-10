// spec-121 — build-phase AC-verification nag (mechanism 1) + per-decision
// test-shape sketches (mechanism 2). Behaviour + wiring tests, each tagged to
// the spec's ACs so a green run flips them verified on prod (the dogfood loop).
//
// Pure-function behaviour (renderAcNagFooter, sketch matcher) is asserted
// directly; the renderSpecPhaseGuidance composition is exercised through the
// exported formatSpecGuidance; the resolve_decision + drift invariants are
// pinned with source-text assertions (the pattern the existing
// test-coverage-nudges / scaffold-drift-guard regressions use).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatSpecGuidance, renderAcNagFooter } from "./formatters.js";
import { sketchShapeForStatement, buildSketchBlock } from "./ac-test-sketch.js";
import { BUILD_AC_NAG_PROSE, toNudge, BASE_SCAFFOLD } from "@memex/shared";
import type { Doc, DocSection } from "../db/schema.js";
import type { AcWithVerification, VerificationState, AcKind } from "../services/acs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(__dirname, "..");
const SPEC = "mindset-prod/memex-building-itself/specs/spec-121";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const formattersSrc = readFileSync(resolve(__dirname, "formatters.ts"), "utf8");
const sketchSrc = readFileSync(resolve(__dirname, "ac-test-sketch.ts"), "utf8");
const toolSpecsSrc = readFileSync(
  resolve(SERVER_SRC, "agent", "tool-specs.ts"),
  "utf8",
);

const baseDate = new Date("2026-06-01T12:00:00Z");

function makeAc(opts: {
  seq: number;
  kind: AcKind;
  state: VerificationState;
  statement?: string;
}): AcWithVerification {
  return {
    ac: {
      seq: opts.seq,
      kind: opts.kind,
      statement: opts.statement ?? `claim number ${opts.seq}`,
      status: "active",
    } as unknown as AcWithVerification["ac"],
    canonicalRef: acRef(opts.seq),
    tests: [],
    verificationState: opts.state,
    daysSinceLastRun: null,
    parents: [],
  };
}

function makeSpecDoc(overrides: Partial<Doc> = {}): Doc & { sections: DocSection[] } {
  return {
    id: "spec-uuid-121",
    memexId: "memex-building-itself",
    handle: "spec-121",
    title: "AC nag spec",
    docType: "spec",
    status: "build",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    pausedAt: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    ...overrides,
    sections: [
      {
        id: "s-uuid-1",
        docId: "spec-uuid-121",
        sectionType: "overview",
        title: "Overview",
        description: null,
        content: "Body.",
        seq: 1,
        preamble: null,
        position: 1,
        status: "active",
        previousStatus: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Mechanism 1 — the nag footer (renderAcNagFooter, pure).
// ──────────────────────────────────────────────────────────────────────────
describe("mechanism 1 — renderAcNagFooter", () => {
  it("surfaces a footer naming the Spec when an AC is not verified", () => {
    tagAc(acRef(1));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
    ]);
    expect(footer).not.toBe("");
    expect(footer).toContain("spec-121");
    expect(footer).toContain("ac-1");
  });

  it("clears when every AC is verified, and returns the moment one regresses", () => {
    tagAc(acRef(2));
    const allGreen = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "scope", state: "verified" }),
      makeAc({ seq: 2, kind: "implementation", state: "verified" }),
    ]);
    expect(allGreen).toBe("");
    const regressed = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "scope", state: "verified" }),
      makeAc({ seq: 2, kind: "implementation", state: "failing" }),
    ]);
    expect(regressed).not.toBe("");
    expect(regressed).toContain("ac-2");
  });

  it("splits ACs into untested and failing groups with their own instructions", () => {
    tagAc(acRef(3));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
      makeAc({ seq: 2, kind: "implementation", state: "failing" }),
    ]);
    expect(footer).toContain(BUILD_AC_NAG_PROSE.untestedLabel);
    expect(footer).toContain(BUILD_AC_NAG_PROSE.untestedInstruction);
    expect(footer).toContain(BUILD_AC_NAG_PROSE.failingLabel);
    expect(footer).toContain(BUILD_AC_NAG_PROSE.failingInstruction);
  });

  it("accounts for both scope and implementation ACs", () => {
    tagAc(acRef(4));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "scope", state: "untested" }),
      makeAc({ seq: 2, kind: "implementation", state: "failing" }),
    ]);
    expect(footer).toContain("ac-1"); // scope
    expect(footer).toContain("ac-2"); // implementation
  });

  it("excludes a verified AC from the footer", () => {
    tagAc(acRef(10));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
      makeAc({ seq: 5, kind: "implementation", state: "verified" }),
    ]);
    expect(footer).toContain("ac-1");
    expect(footer).not.toContain("ac-5");
  });

  it("keeps a failing AC in the failing group rather than clearing it", () => {
    tagAc(acRef(11));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 6, kind: "implementation", state: "failing" }),
    ]);
    const failingIdx = footer.indexOf(BUILD_AC_NAG_PROSE.failingLabel);
    expect(failingIdx).toBeGreaterThan(-1);
    expect(footer.slice(failingIdx)).toContain("ac-6");
  });

  it("shows an untested AC in the untested group", () => {
    tagAc(acRef(12));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 7, kind: "implementation", state: "untested" }),
    ]);
    const untestedIdx = footer.indexOf(BUILD_AC_NAG_PROSE.untestedLabel);
    expect(untestedIdx).toBeGreaterThan(-1);
    expect(footer.slice(untestedIdx)).toContain("ac-7");
  });

  it("excludes a stale AC (passed-but-old counts as covered)", () => {
    tagAc(acRef(13));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
      makeAc({ seq: 8, kind: "implementation", state: "stale" }),
    ]);
    expect(footer).toContain("ac-1");
    expect(footer).not.toContain("ac-8");
  });

  it("includes scope-kind ACs (does not silently skip them)", () => {
    tagAc(acRef(14));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 3, kind: "scope", state: "failing" }),
    ]);
    expect(footer).toContain("ac-3");
  });

  it("puts an untested scope AC in the untested group", () => {
    tagAc(acRef(15));
    const footer = renderAcNagFooter("spec-121", [
      makeAc({ seq: 4, kind: "scope", state: "untested" }),
    ]);
    const untestedIdx = footer.indexOf(BUILD_AC_NAG_PROSE.untestedLabel);
    expect(untestedIdx).toBeGreaterThan(-1);
    expect(footer.slice(untestedIdx)).toContain("ac-4");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Mechanism 1 — composition through renderSpecPhaseGuidance (via the exported
// formatSpecGuidance), and the toNudge channel (dec-2/dec-6 reuse).
// ──────────────────────────────────────────────────────────────────────────
describe("mechanism 1 — composition in build-phase doc state", () => {
  it("computes and appends the nag inside the build-phase guidance", () => {
    tagAc(acRef(8));
    const doc = makeSpecDoc();
    const out = formatSpecGuidance(doc, [], [], undefined, [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
    ]);
    expect(out).toContain("not verified");
    expect(out).toContain("ac-1");
    // Source pin: the build case delegates to renderAcNagFooter (the dynamic
    // lookup lives in renderSpecPhaseGuidance, dec-2).
    expect(formattersSrc).toMatch(/renderAcNagFooter\(doc\.handle/);
  });

  it("rides the toNudge channel — nag composes with phase guidance in one response", () => {
    tagAc(acRef(20));
    const doc = makeSpecDoc();
    const out = formatSpecGuidance(doc, [], [], undefined, [
      makeAc({ seq: 1, kind: "implementation", state: "untested" }),
    ]);
    // toNudge-sourced build prose AND the nag are in the SAME rendered string.
    const buildNudge = toNudge({ dataset: BASE_SCAFFOLD, phase: "build" });
    expect(buildNudge).not.toBe("");
    expect(out).toContain("Tasks are first-class");
    expect(out).toContain("not verified");
  });

  it("emits nothing when every AC is verified (footer fully clears)", () => {
    const doc = makeSpecDoc();
    const out = formatSpecGuidance(doc, [], [], undefined, [
      makeAc({ seq: 1, kind: "implementation", state: "verified" }),
    ]);
    expect(out).not.toContain("not verified");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Mechanism 2 — the deterministic sketch matcher.
// ──────────────────────────────────────────────────────────────────────────
describe("mechanism 2 — sketchShapeForStatement", () => {
  it("maps each documented keyword pattern to its sketch shape", () => {
    tagAc(acRef(17));
    expect(sketchShapeForStatement("GET /install/x returns 404")).toBe(
      "HTTP request, assert status 404",
    );
    expect(
      sketchShapeForStatement("the guidance topic documents only npm install"),
    ).toBe("read the source, assert the absence");
    expect(sketchShapeForStatement("the regression test no longer references the path")).toBe(
      "read the source, assert the absence",
    );
    expect(sketchShapeForStatement("the endpoint accepts a payload and stores it")).toBe(
      "behavioural test against the named endpoint",
    );
    expect(sketchShapeForStatement("the response carries a new field foo")).toBe(
      "payload-shape assertion",
    );
  });

  it("falls through to the generic shape for an unmatched statement", () => {
    tagAc(acRef(18));
    const generic = sketchShapeForStatement("the architecture is coherent end to end");
    expect(generic).toBe("write a test that asserts the AC's claim");
    const block = buildSketchBlock([
      { seq: 9, statement: "the architecture is coherent end to end", canonicalRef: acRef(9) },
    ]);
    expect(block).toContain("write a test that asserts the AC's claim");
    expect(block).toContain(`tagAc('${acRef(9)}')`);
  });

  it("is deterministic with no LLM or network call on the path", () => {
    tagAc(acRef(16));
    // No network/model dependency in the sketch module.
    expect(sketchSrc).not.toMatch(/\bfetch\b|axios|undici|openai|anthropic|https?:\/\//i);
    // Same input → identical output (no randomness, no clock).
    const a = buildSketchBlock([
      { seq: 6, statement: "GET /x returns 404", canonicalRef: acRef(6) },
    ]);
    const b = buildSketchBlock([
      { seq: 6, statement: "GET /x returns 404", canonicalRef: acRef(6) },
    ]);
    expect(a).toBe(b);
  });

  it("produces no sketch block for a decision with zero linked implementation ACs", () => {
    tagAc(acRef(19));
    expect(buildSketchBlock([])).toBe("");
    // Wiring: resolve_decision derives linked impl ACs via ac_parent_links and
    // only blocks when present (dec-6 reuse).
    expect(toolSpecsSrc).toMatch(/buildSketchBlock\(/);
    expect(toolSpecsSrc).toMatch(/kind === "implementation"/);
    expect(toolSpecsSrc).toMatch(/p\.kind === "decision"/);
  });

  it("lists a shape + paste-ready tagAc per linked implementation AC", () => {
    tagAc(acRef(5));
    const block = buildSketchBlock([
      { seq: 6, statement: "GET /x returns 404", canonicalRef: acRef(6) },
      { seq: 7, statement: "the topic documents only npm install", canonicalRef: acRef(7) },
    ]);
    expect(block).toContain("suggested test shape: HTTP request, assert status 404");
    expect(block).toContain(`tagAc('${acRef(6)}')`);
    expect(block).toContain("suggested test shape: read the source, assert the absence");
    expect(block).toContain(`tagAc('${acRef(7)}')`);
  });

  // spec-157 t-2 (dec-1): nudges appended to a tool result start after a BLANK
  // line — the doc chat splits the result on the first `\n\n` and shows the
  // human only the leading chunk. A sketch block leading with a single `\n`
  // would leak its intro line into that chunk.
  it("sketch block starts after a blank line, so the doc chat's first-chunk split hides it (spec-157 ac-5)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-157/acs/ac-5");
    const block = buildSketchBlock([
      { seq: 6, statement: "GET /x returns 404", canonicalRef: acRef(6) },
    ]);
    expect(block.startsWith("\n\n")).toBe(true);
    // The composed resolve_decision result splits at the first blank line into
    // exactly the outcome sentence — nothing of the sketch survives the split.
    const composed = `Decision resolved: ref: ${SPEC}/decisions/dec-1 "title" — resolution.${block}`;
    expect(composed.split("\n\n", 1)[0]).toBe(
      `Decision resolved: ref: ${SPEC}/decisions/dec-1 "title" — resolution.`,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// t-1 — scaffold prose home + drift invariants (ac-7, ac-9).
// ──────────────────────────────────────────────────────────────────────────
describe("t-1 — nag prose lives in the Scaffold, not inline in server", () => {
  it("defines the nag template prose in the Scaffold and consumes it in the formatter (ac-7)", () => {
    tagAc(acRef(7));
    // Prose exported from @memex/shared.
    expect(typeof BUILD_AC_NAG_PROSE.heading).toBe("function");
    expect(BUILD_AC_NAG_PROSE.heading("spec-121", 2)).toContain("not verified");
    // The formatter imports the prose rather than inlining the heading text.
    expect(formattersSrc).toMatch(/BUILD_AC_NAG_PROSE/);
    expect(formattersSrc).not.toMatch(/not verified\./);
  });

  it("the Scaffold's build-phase footer mentions the nag + sketches mechanism (test f)", () => {
    tagAc(acRef(7));
    const buildNudge = toNudge({ dataset: BASE_SCAFFOLD, phase: "build" });
    expect(buildNudge).toMatch(/nag/i);
    expect(buildNudge).toMatch(/sketch/i);
  });

  it("adds no new phases/*.md file — scaffold-drift-guard stays green (ac-9)", () => {
    tagAc(acRef(9));
    const ALLOWLIST = new Set([
      "_base/code-grounding.md",
      "_base/standards-protocol.md",
      "creation/system.md",
    ]);
    const phasesDir = resolve(SERVER_SRC, "agent", "phases");
    const found: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (statSync(full).isDirectory()) walk(full, rel);
        else if (name.endsWith(".md")) found.push(rel);
      }
    };
    walk(phasesDir, "");
    for (const md of found) {
      expect(ALLOWLIST.has(md), `unexpected phases/*.md: ${md}`).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// t-4 — both mechanisms ship together (ac-6).
// ──────────────────────────────────────────────────────────────────────────
describe("integration — both mechanisms ship together (ac-6)", () => {
  it("in one build-phase scenario the nag footer renders AND resolve sketches a test shape", () => {
    tagAc(acRef(6));
    // Mechanism 1: a not-verified AC makes the nag appear in the doc response.
    const doc = makeSpecDoc();
    const docState = formatSpecGuidance(
      doc,
      [],
      [], undefined, [makeAc({ seq: 6, kind: "implementation", state: "untested" })],
    );
    expect(docState).toContain("not verified");
    expect(docState).toContain("ac-6");

    // Mechanism 2: resolving a decision with a linked implementation AC yields
    // a sketch block in the same release.
    const sketch = buildSketchBlock([
      { seq: 6, statement: "GET /x returns 404", canonicalRef: acRef(6) },
    ]);
    expect(sketch).not.toBe("");
    expect(sketch).toContain("suggested test shape:");
    expect(sketch).toContain(`tagAc('${acRef(6)}')`);
  });
});
