import { describe, it, expect } from "vitest";
import {
  parseRef,
  formatRef,
  type ParsedRef,
  type DocType,
  type ChildType,
} from "./refs.js";
import { tagAc } from "@memex-ai-ac/vitest";

// Strict canonical-ref parser coverage. Loose forms (`spec36`, `Spec-36`, `36`, etc.)
// are rejected at this layer — tolerance lives in the chat surface.

const NS = "mindset-int";
const MX = "memex-app";

// spec-150 t-5 — clause ref grammar. These AC refs are mindset-prod (the spec lives
// there); tagAc routes emissions to memex.ai. Run locally with MEMEX_EMIT=false.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

function ok(input: string): ParsedRef {
  const result = parseRef(input);
  if (!result.ok) {
    throw new Error(
      `expected parseRef("${input}") to succeed, got: ${result.reason}`,
    );
  }
  return result.ref;
}

describe("parseRef — valid shapes (doc only)", () => {
  it("parses a spec ref", () => {
    expect(ok(`${NS}/${MX}/specs/spec-36`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "specs",
      docHandle: "spec-36",
    });
  });

  it("parses a spec ref with a small N (round-trip sanity for `spec-5`)", () => {
    expect(ok(`${NS}/${MX}/specs/spec-5`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "specs",
      docHandle: "spec-5",
    });
  });

  it("parses a doc ref", () => {
    expect(ok(`${NS}/${MX}/docs/doc-28`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "docs",
      docHandle: "doc-28",
    });
  });

  it("parses a standard ref", () => {
    expect(ok(`${NS}/${MX}/standards/std-5`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "standards",
      docHandle: "std-5",
    });
  });

  it("parses an execution-plan ref (handle prefix is `doc-`)", () => {
    expect(ok(`${NS}/${MX}/execution-plans/doc-42`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "execution-plans",
      docHandle: "doc-42",
    });
  });

  it("accepts kebab-case namespace and memex slugs", () => {
    expect(ok("acme-co/my-workspace-2/specs/spec-1").namespace).toBe("acme-co");
    expect(ok("acme-co/my-workspace-2/specs/spec-1").memex).toBe("my-workspace-2");
  });

  it("accepts multi-digit handle numbers", () => {
    expect(ok(`${NS}/${MX}/docs/doc-10000`).docHandle).toBe("doc-10000");
  });
});

describe("parseRef — valid shapes (with child)", () => {
  it("parses a section under a standard", () => {
    expect(ok(`${NS}/${MX}/standards/std-5/sections/s-2`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "standards",
      docHandle: "std-5",
      child: { type: "sections", handle: "s-2" },
    });
  });

  it("parses a decision under a spec", () => {
    expect(ok(`${NS}/${MX}/specs/spec-36/decisions/dec-7`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "specs",
      docHandle: "spec-36",
      child: { type: "decisions", handle: "dec-7" },
    });
  });

  it("parses a task under a doc", () => {
    expect(ok(`${NS}/${MX}/docs/doc-28/tasks/t-1`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "docs",
      docHandle: "doc-28",
      child: { type: "tasks", handle: "t-1" },
    });
  });

  it("parses a comment under an execution-plan", () => {
    expect(ok(`${NS}/${MX}/execution-plans/doc-42/comments/c-3`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "execution-plans",
      docHandle: "doc-42",
      child: { type: "comments", handle: "c-3" },
    });
  });
});

describe("parseRef — rejects malformed handles", () => {
  it.each([
    "spec36",
    "Spec-36",
    "36",
    "mindset-int/memex-app/specs/spec36",
    "mindset-int/memex-app/specs/Spec-36",
    "mindset-int/memex-app/specs/36",
    "mindset-int/memex-app/specs/spec-",
    "mindset-int/memex-app/specs/spec-0",
    "mindset-int/memex-app/specs/spec-01",
    "mindset-int/memex-app/specs/spec-1a",
    "mindset-int/memex-app/specs/spec--1",
  ])("rejects %s", (input) => {
    const r = parseRef(input);
    expect(r.ok).toBe(false);
  });
});

describe("parseRef — rejects legacy `briefs` / `b-N` shapes (renamed in b-105)", () => {
  // After b-105 the doc-type path segment is `specs` and the handle prefix is
  // `spec-`; the prior `briefs` / `b-N` forms must no longer parse.
  it.each([
    `${NS}/${MX}/briefs/b-1`,
    `${NS}/${MX}/briefs/b-36`,
    `${NS}/${MX}/briefs/spec-1`,
    `${NS}/${MX}/specs/b-1`,
  ])("rejects %s", (input) => {
    expect(parseRef(input).ok).toBe(false);
  });
});

describe("parseRef — rejects mismatched doc-type/handle pairing", () => {
  it("rejects specs/doc-1", () => {
    const r = parseRef(`${NS}/${MX}/specs/doc-1`);
    expect(r.ok).toBe(false);
  });

  it("rejects standards/spec-1", () => {
    const r = parseRef(`${NS}/${MX}/standards/spec-1`);
    expect(r.ok).toBe(false);
  });

  it("rejects docs/spec-1", () => {
    const r = parseRef(`${NS}/${MX}/docs/spec-1`);
    expect(r.ok).toBe(false);
  });

  it("rejects docs/std-1", () => {
    const r = parseRef(`${NS}/${MX}/docs/std-1`);
    expect(r.ok).toBe(false);
  });

  it("rejects execution-plans/std-1", () => {
    const r = parseRef(`${NS}/${MX}/execution-plans/std-1`);
    expect(r.ok).toBe(false);
  });

  it("rejects standards/doc-1", () => {
    const r = parseRef(`${NS}/${MX}/standards/doc-1`);
    expect(r.ok).toBe(false);
  });
});

describe("parseRef — rejects mismatched child-type/handle pairing", () => {
  it.each([
    `${NS}/${MX}/docs/doc-1/sections/t-1`,
    `${NS}/${MX}/docs/doc-1/tasks/s-1`,
    `${NS}/${MX}/docs/doc-1/decisions/c-1`,
    `${NS}/${MX}/docs/doc-1/comments/dec-1`,
    `${NS}/${MX}/docs/doc-1/tasks/T-1`,
    `${NS}/${MX}/docs/doc-1/sections/S-1`,
  ])("rejects %s", (input) => {
    expect(parseRef(input).ok).toBe(false);
  });
});

describe("parseRef — rejects bad casing on namespace/memex/types", () => {
  it.each([
    "MINDSET/memex/specs/spec-36",
    "mindset-int/MEMEX-app/specs/spec-36",
    "mindset-int/memex-app/Specs/spec-36",
    "mindset-int/memex-app/SPECS/spec-36",
    "mindset-int/memex-app/specs/spec-36/Tasks/t-1",
    "mindset-int/memex-app/Docs/doc-1",
    "mindset-int/memex-app/Execution-Plans/doc-1",
  ])("rejects %s", (input) => {
    expect(parseRef(input).ok).toBe(false);
  });
});

describe("parseRef — rejects bad slug shapes", () => {
  it.each([
    "1mindset/memex/specs/spec-1", // starts with digit
    "-mindset/memex/specs/spec-1", // starts with hyphen
    "mindset_/memex/specs/spec-1", // underscore
    "mind set/memex/specs/spec-1", // space (caught by whitespace check)
    "mindset./memex/specs/spec-1", // dot
    "mindset/1memex/specs/spec-1", // memex starts with digit
  ])("rejects %s", (input) => {
    expect(parseRef(input).ok).toBe(false);
  });
});

describe("parseRef — rejects structural problems", () => {
  it("rejects empty string", () => {
    expect(parseRef("").ok).toBe(false);
  });

  it("rejects leading slash", () => {
    expect(parseRef(`/${NS}/${MX}/specs/spec-1`).ok).toBe(false);
  });

  it("rejects trailing slash", () => {
    expect(parseRef(`${NS}/${MX}/specs/spec-1/`).ok).toBe(false);
  });

  it("rejects too few segments (missing handle)", () => {
    expect(parseRef(`${NS}/${MX}/specs`).ok).toBe(false);
  });

  it("rejects too few segments (missing doc type)", () => {
    expect(parseRef(`${NS}/${MX}`).ok).toBe(false);
  });

  it("rejects too few segments (just namespace)", () => {
    expect(parseRef(NS).ok).toBe(false);
  });

  it("rejects an odd segment count (5)", () => {
    expect(parseRef(`${NS}/${MX}/specs/spec-1/tasks`).ok).toBe(false);
  });

  it("rejects too many segments (7)", () => {
    expect(parseRef(`${NS}/${MX}/specs/spec-1/tasks/t-1/extra`).ok).toBe(false);
  });

  it("rejects double slash", () => {
    expect(parseRef(`${NS}//${MX}/specs/spec-1`).ok).toBe(false);
  });

  it("rejects unknown doc type", () => {
    expect(parseRef(`${NS}/${MX}/missions/spec-1`).ok).toBe(false);
  });

  it("rejects unknown child type", () => {
    expect(parseRef(`${NS}/${MX}/docs/doc-1/notes/c-1`).ok).toBe(false);
  });

  it("attaches the failing input on the result", () => {
    const r = parseRef("not a ref");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.input).toBe("not a ref");
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("formatRef", () => {
  it("formats a doc-only spec ref", () => {
    expect(
      formatRef({
        namespace: NS,
        memex: MX,
        docType: "specs",
        docHandle: "spec-36",
      }),
    ).toBe(`${NS}/${MX}/specs/spec-36`);
  });

  it("formats a spec ref with a small N (`/specs/spec-5`)", () => {
    expect(
      formatRef({
        namespace: NS,
        memex: MX,
        docType: "specs",
        docHandle: "spec-5",
      }),
    ).toBe(`${NS}/${MX}/specs/spec-5`);
  });

  it("formats a ref with child", () => {
    expect(
      formatRef({
        namespace: NS,
        memex: MX,
        docType: "docs",
        docHandle: "doc-28",
        child: { type: "tasks", handle: "t-1" },
      }),
    ).toBe(`${NS}/${MX}/docs/doc-28/tasks/t-1`);
  });
});

describe("spec-150 t-5: clause ref grammar (flat, cl- prefix)", () => {
  it("parses a clause under a standard (ac-4, ac-17)", () => {
    tagAc(AC(4)); // scope: clauses are individually addressable by a stable canonical ref
    tagAc(AC(17));
    expect(ok(`${NS}/${MX}/standards/std-5/clauses/cl-2`)).toEqual({
      namespace: NS,
      memex: MX,
      docType: "standards",
      docHandle: "std-5",
      child: { type: "clauses", handle: "cl-2" },
    });
  });

  it("formats and round-trips a clause ref (ac-17)", () => {
    tagAc(AC(17));
    const ref: ParsedRef = {
      namespace: NS,
      memex: MX,
      docType: "standards",
      docHandle: "std-5",
      child: { type: "clauses", handle: "cl-2" },
    };
    const formatted = formatRef(ref);
    expect(formatted).toBe(`${NS}/${MX}/standards/std-5/clauses/cl-2`);
    const parsed = parseRef(formatted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.ref).toEqual(ref);
  });

  it("the clause ref is FLAT — no section segment, so it is stable across section moves (ac-18)", () => {
    tagAc(AC(18));
    // The clause's address carries no section component, so moving the clause
    // between sections cannot change its ref. The nested 8-segment form is not
    // even a legal ref (parseRef accepts 4 or 6 segments only), which is what
    // forced the flat grammar in the first place.
    expect(parseRef(`${NS}/${MX}/standards/std-5/clauses/cl-2`).ok).toBe(true);
    expect(
      parseRef(`${NS}/${MX}/standards/std-5/sections/s-1/clauses/cl-2`).ok,
    ).toBe(false);
  });

  it("keeps clause and comment handles unambiguous — no c-/cl- collision (ac-18)", () => {
    tagAc(AC(18));
    // A comment-prefixed handle is invalid under clauses, and a clause-prefixed
    // handle is invalid under comments. The child-type segment + the distinct
    // prefix together keep a bare handle unambiguous.
    expect(parseRef(`${NS}/${MX}/standards/std-5/clauses/c-2`).ok).toBe(false);
    expect(parseRef(`${NS}/${MX}/docs/doc-1/comments/cl-2`).ok).toBe(false);
  });

  it("rejects UUID-form clause handles and bare-UUID refs (ac-19, std-10)", () => {
    tagAc(AC(19));
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(parseRef(`${NS}/${MX}/standards/std-5/clauses/${uuid}`).ok).toBe(false);
    expect(parseRef(uuid).ok).toBe(false);
  });

  it("rejects malformed clause handles (ac-17)", () => {
    tagAc(AC(17));
    for (const bad of ["cl-0", "cl-01", "cl-", "cl-1a", "CL-1", "clause-1", "c1-1"]) {
      expect(
        parseRef(`${NS}/${MX}/standards/std-5/clauses/${bad}`).ok,
      ).toBe(false);
    }
  });
});

describe("round-trip: parseRef(formatRef(x)).ref deep-equals x", () => {
  // One canonical example per (docType, childType?) combination.
  const docOnlyCases: Array<{ docType: DocType; docHandle: string }> = [
    { docType: "specs", docHandle: "spec-1" },
    { docType: "specs", docHandle: "spec-999" },
    { docType: "docs", docHandle: "doc-1" },
    { docType: "docs", docHandle: "doc-28" },
    { docType: "standards", docHandle: "std-1" },
    { docType: "standards", docHandle: "std-5" },
    { docType: "execution-plans", docHandle: "doc-1" },
    { docType: "execution-plans", docHandle: "doc-42" },
  ];

  const childCases: Array<{ type: ChildType; handle: string }> = [
    { type: "sections", handle: "s-1" },
    { type: "sections", handle: "s-12" },
    { type: "decisions", handle: "dec-1" },
    { type: "decisions", handle: "dec-7" },
    { type: "tasks", handle: "t-1" },
    { type: "tasks", handle: "t-42" },
    { type: "comments", handle: "c-1" },
    { type: "comments", handle: "c-99" },
    { type: "clauses", handle: "cl-1" },
    { type: "clauses", handle: "cl-7" },
  ];

  for (const docCase of docOnlyCases) {
    const ref: ParsedRef = {
      namespace: NS,
      memex: MX,
      docType: docCase.docType,
      docHandle: docCase.docHandle,
    };
    it(`round-trips ${formatRef(ref)}`, () => {
      const formatted = formatRef(ref);
      const parsed = parseRef(formatted);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.ref).toEqual(ref);
      }
    });
  }

  for (const docCase of docOnlyCases) {
    for (const child of childCases) {
      const ref: ParsedRef = {
        namespace: NS,
        memex: MX,
        docType: docCase.docType,
        docHandle: docCase.docHandle,
        child: { type: child.type, handle: child.handle },
      };
      it(`round-trips ${formatRef(ref)}`, () => {
        const formatted = formatRef(ref);
        const parsed = parseRef(formatted);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.ref).toEqual(ref);
        }
      });
    }
  }
});
