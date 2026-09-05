// spec-538 t-12 (ac-33) — budget-compliant must mean DELIVERABLE.
//
// issue-4: a response that satisfied EVERY asserted bound was refused by an MCP
// client and spilled to a file. Body 37,744 (under the 40,000 budget), envelope
// 14,815 (inside the 23,244 worst case), total 52,559 (18,235 under
// MEASURED_CAP_BOUND_CHARS). Every mechanism this Spec built worked; delivery
// failed anyway.
//
// s-1's first paragraph is the contract this file holds: "This is a DELIVERY
// defect, not a verbosity preference." Every existing bound in this Spec asserts
// a SIZE. Size was never the contract.
//
// These assertions are RED on the tree that introduced them, deliberately, and
// they go green only once BOTH the wiring (t-12) and the constants (t-13) are
// fixed. ac-33 is the bug's criterion and it spans both tasks — see the
// bug -> failing-AC -> green-AC -> resolved loop on issue-4.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  RESPONSE_BUDGET_CHARS,
  MEASURED_ENVELOPE_MAX_CHARS,
  DECLARED_CLIENT_RESULT_CEILING_CHARS,
  CLIENT_DEFAULT_CEILING_CHARS,
} from "./response-budget.js";
import { formatFullDocState } from "./formatters.js";
import { createMcpServer } from "./tools.js";
import type { Doc, DocSection } from "../db/schema.js";

const TEST_USER_ID = "00000000-0000-0000-0000-00000000beef";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

/**
 * The client's DEFAULT refusal threshold, read from the client itself on
 * 2026-09-04 — the fact from the thing, not from a record of it [per std-50 cl-1]:
 *
 *   var eG = 50000, TBe = 500000;
 *   function h3e(name, own, ceiling = eG, skipAggregate = false) {
 *     …
 *     return Math.min(own, ceiling);
 *   }
 *
 * Corroborated end-to-end on the founding payload: the persisted JSON measured
 * 53,247 chars, the client reported "Output too large (52KB)" — 53,247/1024 =
 * 52.0 — and refused it. Over by 3,247.
 *
 * Kept here as the number the declaration REPLACES, so the next reader can see
 * what would apply if the `_meta` declaration were ever dropped.
 */
// (imported from response-budget.ts — t-12 promoted it there.)

/**
 * How much of the ceiling stays unspent — a margin, never an equality, because
 * the ceiling is still the client's to change.
 */
const REQUIRED_CEILING_MARGIN = 2_000;

/**
 * Tools that do NOT carry the `_meta` declaration on the wire — issue-5.
 *
 * `list_memexes` is registered through the positional
 * `server.tool(name, description, shape, annotations, handler)` overload
 * (`tools.ts`, "MCP-only: Memex discovery"), which has no `_meta` parameter at
 * all. The other 70 tools go through the `registerTool` loop that attaches it.
 * So the declaration is NOT uniform, whatever the comment at the registration
 * site says, and this list is the honest name for that.
 *
 * Consequence today: nothing. `list_memexes` returns a short membership list
 * plus the guidance topic index, nowhere near the client's 50,000 default. It
 * is pinned rather than fixed because the fix is a separate call (issue-5) —
 * NOT because an exemption is the right shape.
 *
 * This is debt with an expiry, not a category. When issue-5 lands, this array
 * empties and the assertion below reds until the entry is deleted.
 *
 * Found by t-14's wire read against prod, 2026-09-05: 71 tools in
 * `tools/list`, 70 carrying `anthropic/maxResultSizeChars: 70000`. The
 * source-text check above was green throughout — a grep cannot see a wire.
 */
/**
 * Tools that legitimately ship no ceiling declaration. EMPTY, and it should stay
 * that way — spec-538 issue-5 closed the one entry it ever held.
 *
 * `list_memexes` was registered through the positional
 * `server.tool(name, description, shape, annotations, handler)` overload, which
 * has no `_meta` parameter, so it shipped `_meta: null` while the other 70 tools
 * carried the declaration. It is on `registerTool` now.
 *
 * Kept as a named empty list rather than deleted: the assertion below is an exact
 * equality, so a tool added through the positional overload reds this test and
 * whoever hits it needs somewhere to record a deliberate exemption — with its
 * reason [per std-50 cl-6] — rather than weakening the assertion to a subset check.
 */
const KNOWN_UNDECLARED_TOOLS: readonly string[] = [];

describe("the declaration replaces the guess, and it is the operative ceiling", () => {
  it("declares more room than the client's default, and far less than the maximum", () => {
    tagAc(AC(33));
    // dec-9 option (c). Both bounds matter: below the default it would be
    // pointless, at the 500,000 maximum it would disable the client's context
    // protection — which is the interest this Spec exists to serve.
    expect(DECLARED_CLIENT_RESULT_CEILING_CHARS).toBeGreaterThan(
      CLIENT_DEFAULT_CEILING_CHARS,
    );
    expect(DECLARED_CLIENT_RESULT_CEILING_CHARS).toBeLessThanOrEqual(100_000);
  });

  it("the declaration is written against the constant, not inlined", () => {
    tagAc(AC(33));
    // Narrow by design: this reads SOURCE TEXT, so it can only speak about how
    // the value is spelled — never about what any tool actually carries. It used
    // to be titled "every MCP tool advertises it", which is a claim about the
    // WIRE that a grep cannot make; the test below makes that one. Kept because
    // it still guards something real: the ceiling must reference the owned
    // constant so [per std-50 cl-6] the reason stays attached to the number.
    const src = readFileSync(
      fileURLToPath(new URL("./tools.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain('"anthropic/maxResultSizeChars"');
    expect(src).toContain("DECLARED_CLIENT_RESULT_CEILING_CHARS");
  });

  it("every registered tool carries the declaration — asserted over the tool list, not the source", () => {
    tagAc(AC(33));
    const server = createMcpServer(TEST_USER_ID);
    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { _meta?: Record<string, unknown> }>;
      }
    )._registeredTools;

    // Sanity on the instrument before asserting with it: if the SDK ever stops
    // exposing `_meta` here, EVERY tool looks undeclared and the failure would
    // read as a catastrophic regression instead of a harness break. Assert the
    // harness can see a declaration at all before trusting the ones it can't.
    expect(Object.keys(registered).length).toBeGreaterThan(1);
    expect(
      Object.values(registered).filter(
        (t) =>
          t._meta?.["anthropic/maxResultSizeChars"] ===
          DECLARED_CLIENT_RESULT_CEILING_CHARS,
      ).length,
    ).toBeGreaterThan(1);

    const undeclared = Object.entries(registered)
      .filter(
        ([, tool]) =>
          tool._meta?.["anthropic/maxResultSizeChars"] !==
          DECLARED_CLIENT_RESULT_CEILING_CHARS,
      )
      .map(([name]) => name)
      .sort();

    // Exact equality in BOTH directions, deliberately. A new tool that misses
    // the declaration reds this; so does fixing `list_memexes` without deleting
    // the line below. A known gap that can silently become permanent is how the
    // gap got here.
    expect(undeclared).toEqual(KNOWN_UNDECLARED_TOOLS);
  });
});

/**
 * What the client actually weighs.
 *
 * From the same client source: the persisted value is
 * `l = Array.isArray(n) ? JSON.stringify(n, null, 2) : n`, and the threshold is
 * compared against `l.length`. So the server's rendered text is NOT the measured
 * quantity — the JSON envelope around it is, and `formatFullDocState` cannot see
 * that difference. On the founding payload it was 688 chars (52,559 -> 53,247),
 * ~1.3%, and it scales with newline count because each `\n` is escaped to two
 * characters.
 */
function serialisedLengthAsClientWeighsIt(text: string): number {
  return JSON.stringify([{ type: "text", text }], null, 2).length;
}

describe("the serialisation model matches the client, before it is used to judge anything", () => {
  it("reproduces the client's own JSON.stringify(content, null, 2) shape", () => {
    // Assert the instrument before asserting with it: a delivery test built on a
    // wrong model of what the client measures would be confidently useless.
    const text = "a\nb";
    expect(JSON.stringify([{ type: "text", text }], null, 2)).toBe(
      '[\n  {\n    "type": "text",\n    "text": "a\\nb"\n  }\n]',
    );
    // And it must OVER-count the rendered text, never under-count it.
    expect(serialisedLengthAsClientWeighsIt(text)).toBeGreaterThan(text.length);
  });

  it("the overhead grows with newlines, which is why a fixed constant would drift", () => {
    const flat = "x".repeat(1_000);
    const lined = "x\n".repeat(500);
    expect(flat.length).toBe(lined.length);
    expect(serialisedLengthAsClientWeighsIt(lined)).toBeGreaterThan(
      serialisedLengthAsClientWeighsIt(flat),
    );
  });
});

describe("budget-compliant implies deliverable (ac-33)", () => {
  it("one full budget, serialised, fits under the declared ceiling", () => {
    tagAc(AC(33));
    // t-15 made the budget INCLUSIVE of the envelope, so the arithmetic is no
    // longer additive: adding MEASURED_ENVELOPE_MAX_CHARS on top would
    // double-count what the allocator already reserved. What must arrive is one
    // full budget, weighed the way the client weighs it.
    const onTheWire = serialisedLengthAsClientWeighsIt(
      "P".repeat(RESPONSE_BUDGET_CHARS),
    );

    expect(
      onTheWire,
      `a full ${RESPONSE_BUDGET_CHARS} budget serialises to ${onTheWire}, ` +
        `against the declared ${DECLARED_CLIENT_RESULT_CEILING_CHARS} ` +
        `less a ${REQUIRED_CEILING_MARGIN} margin`,
    ).toBeLessThanOrEqual(
      DECLARED_CLIENT_RESULT_CEILING_CHARS - REQUIRED_CEILING_MARGIN,
    );

    // The declaration must be load-bearing, not cosmetic: a full budget must NOT
    // fit under the client's bare default, or dropping the `_meta` would cost
    // nothing and the ceiling would be back to being inferred.
    expect(
      onTheWire,
      "the declaration must be load-bearing, not cosmetic",
    ).toBeGreaterThan(CLIENT_DEFAULT_CEILING_CHARS);
  });

  it("a real render whose body sits NEAR the budget arrives, envelope included", () => {
    tagAc(AC(33));
    // The existing ac-1/ac-4 checks assert `out.length <= RESPONSE_BUDGET_CHARS`
    // and stop there — they measure the body alone, which is the half that was
    // never in doubt. This one carries the envelope the response is actually
    // emitted alongside, and weighs the result the way the client does.
    //
    // FIXTURE CHOICE, and it is the whole test. The first version of this used
    // spec-472's 85,580 chars of prose — and PASSED, uselessly: that much prose
    // trips tier 3, the section bodies are dropped, and the body collapses to a
    // small map that fits alongside any envelope. The defect lives where the
    // body is NEAR the budget and still renders in full (the founding payload's
    // body was 37,744), so the prose is sized to stay in tier 1.
    //
    // This is the ac-4 flaw one level up — s-5 §3: a fixture "structurally
    // unable to observe the largest region" of what it claims to bound. Hence
    // the fixture-reality assertion below, before anything is concluded from it.
    const baseDate = new Date("2026-03-25T12:00:00Z");
    const doc = {
      id: "d1",
      memexId: "m1",
      handle: "spec-1",
      title: "Representative",
      docType: "spec",
      status: "build",
      createdAt: baseDate,
      statusChangedAt: baseDate,
      version: 1,
      sensitive: false,
      sensitiveByName: null,
      checkedOutBy: null,
      checkedOutAt: null,
      sections: [
        {
          id: "s1",
          docId: "d1",
          sectionType: "overview",
          title: "Overview",
          // Sized to land the body just under the budget in tier 1 — the shape
          // that actually spilled. NOT spec-472's 85,580, which trips tier 3.
          content: "P".repeat(35_000),
          seq: 1,
          position: 1,
          status: "active",
          createdAt: baseDate,
          updatedAt: baseDate,
        } as unknown as DocSection,
      ],
    } as unknown as Doc & { sections: DocSection[] };

    const body = formatFullDocState(doc, [], []);

    // FIXTURE REALITY, asserted before it is trusted. If a future change makes
    // this collapse to a tier-3 map, THIS fails loudly rather than the delivery
    // claim below passing for the wrong reason.
    expect(
      body.length,
      `the fixture must exercise a near-budget body, not a collapsed map; ` +
        `rendered ${body.length} against a ${RESPONSE_BUDGET_CHARS} budget`,
    ).toBeGreaterThan(30_000);

    const withEnvelope = body + "G".repeat(MEASURED_ENVELOPE_MAX_CHARS);
    const onTheWire = serialisedLengthAsClientWeighsIt(withEnvelope);

    expect(
      onTheWire,
      `body rendered ${body.length}, on the wire ${onTheWire}`,
    ).toBeLessThanOrEqual(
      DECLARED_CLIENT_RESULT_CEILING_CHARS - REQUIRED_CEILING_MARGIN,
    );
  });

  it("the reserve tracks THIS response's envelope, not the population maximum (ac-34)", () => {
    tagAc(AC(34));
    // REPLACES a source scan that passed for the wrong reason. It looked for
    // `envelopeChars: 0` and, once t-15 removed that string, `indexOf` returned
    // -1, the slice widened to the whole file, and the assertion matched prose
    // elsewhere in it. A green test measuring nothing — the exact class of defect
    // this Spec exists to fight, committed by its own guard for the second time
    // (see ac-4, s-5 §3).
    //
    // So this asserts through the RENDERED OUTPUT instead. A source read cannot
    // distinguish a computed reserve from a hardcoded one; only behaviour can.
    const baseDate = new Date("2026-03-25T12:00:00Z");
    const specOfPhase = (status: string): string => {
      const doc = {
        id: "d1",
        memexId: "m1",
        handle: "spec-1",
        title: "Representative",
        docType: "spec",
        status,
        createdAt: baseDate,
        statusChangedAt: baseDate,
        version: 1,
        sensitive: false,
        sensitiveByName: null,
        checkedOutBy: null,
        checkedOutAt: null,
        sections: [
          {
            id: "s1",
            docId: "d1",
            sectionType: "overview",
            title: "Overview",
            content: "P".repeat(20_000),
            seq: 1,
            position: 1,
            status: "active",
            createdAt: baseDate,
            updatedAt: baseDate,
          } as unknown as DocSection,
        ],
      } as unknown as Doc & { sections: DocSection[] };
      // Enough decision weight to force tier 2, so the remainder is visible as
      // excerpt length rather than hidden by everything fitting.
      const decisions = Array.from({ length: 12 }, (_, i) => ({
        id: `dec${i}`,
        docId: "d1",
        seq: i + 1,
        handle: `dec-${i + 1}`,
        title: `Decision ${i + 1}`,
        status: "resolved",
        resolution: "R".repeat(20_000),
        context: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      })) as unknown as Parameters<typeof formatFullDocState>[1];
      return formatFullDocState(doc, decisions, []);
    };

    // `specify` carries the largest phase guidance (13,174 + a 1,308 handoff);
    // `done` the smallest (4,150 and no handoff). Same document, same content.
    const specify = specOfPhase("specify");
    const done = specOfPhase("done");

    expect(
      done.length,
      `done rendered ${done.length}, specify ${specify.length} — the phase with ` +
        "the smaller envelope must keep more content",
    ).toBeGreaterThan(specify.length);

    // And it must not be a flat worst-case reservation (dec-7 option (a)): the
    // difference has to come from the phases' real guidance sizes, so the gap
    // must be well under the population maximum it would otherwise both reserve.
    const gap = done.length - specify.length;
    expect(gap).toBeGreaterThan(0);
    expect(
      gap,
      "a flat MEASURED_ENVELOPE_MAX_CHARS reserve would make the phases identical",
    ).toBeLessThan(MEASURED_ENVELOPE_MAX_CHARS);

    // Both still fit, which is the bound the reserve exists to hold.
    for (const out of [specify, done]) {
      expect(out.length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    }
  });
});
