// Canonical-ref parser for Memex URL paths.
//
// Canonical refs look like:
//   <ns>/<mx>/<doc-type>/<doc-handle>(/<child-type>/<child-handle>)?
//
// Examples:
//   mindset-int/memex-app/specs/spec-36
//   mindset-int/memex-app/docs/doc-28/tasks/t-1
//   mindset-int/memex-app/standards/std-5/sections/s-2
//
// This parser is strict by design: loose forms (`spec36`, `Spec-36`, `36`, missing
// prefixes, wrong case, leading/trailing slashes) are rejected. Tolerance for
// user-typed input lives at the chat surface, not here.

export type DocType = "specs" | "docs" | "standards" | "execution-plans";
// `issues` (spec-112): Issues hang off a Spec under `/issues/issue-N`, mirroring
// how decisions/tasks/acs hang off the Spec. The `issue-N` handle is the per-Spec
// issue seq minted by services/issues.ts — same `<prefix>-N` shape rule as
// dec-N/t-N. Renamed from the bare `i-N` form per spec-158 dec-3 (hard cutover, no
// backwards-compat alias — product unreleased).
// `clauses` (spec-150): standard clauses hang off a Standard under `/clauses/cl-N`,
// FLAT (not nested under a section) so a clause's ref stays stable when the clause
// moves between sections. The handle prefix is `cl-`, deliberately distinct from
// comments' `c-`, so a bare handle is never ambiguous between a comment and a clause.
export type ChildType =
  | "sections"
  | "decisions"
  | "tasks"
  | "comments"
  | "acs"
  | "issues"
  | "clauses";

export type ParsedRef = {
  namespace: string;
  memex: string;
  docType: DocType;
  /** Canonical handle form, e.g. "spec-36", "doc-28", "std-5". */
  docHandle: string;
  child?: { type: ChildType; handle: string };
};

export type RefParseResult =
  | { ok: true; ref: ParsedRef }
  | { ok: false; reason: string; input: string };

// kebab-lowercase: starts with a-z, then a-z / 0-9 / hyphen.
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

const DOC_TYPES = new Set<DocType>([
  "specs",
  "docs",
  "standards",
  "execution-plans",
]);

const CHILD_TYPES = new Set<ChildType>([
  "sections",
  "decisions",
  "tasks",
  "comments",
  "acs",
  "issues",
  "clauses",
]);

// Doc handle prefix per doc type. `docs` and `execution-plans` both use `doc-N`.
const DOC_HANDLE_PREFIX: Record<DocType, string> = {
  specs: "spec",
  docs: "doc",
  standards: "std",
  "execution-plans": "doc",
};

const CHILD_HANDLE_PREFIX: Record<ChildType, string> = {
  sections: "s",
  decisions: "dec",
  tasks: "t",
  comments: "c",
  acs: "ac",
  issues: "issue",
  clauses: "cl",
};

function isPositiveIntString(s: string): boolean {
  // Strict positive integer: no leading zero (except literal "0", which we also
  // disallow since handles are 1-based), no sign, no whitespace.
  return /^[1-9][0-9]*$/.test(s);
}

function isValidHandle(handle: string, expectedPrefix: string): boolean {
  // Handle form: `<prefix>-<positive-int>`. Strict — no uppercase, no extra
  // segments, no leading zeros.
  const dash = handle.indexOf("-");
  if (dash < 0) return false;
  const prefix = handle.slice(0, dash);
  const num = handle.slice(dash + 1);
  if (prefix !== expectedPrefix) return false;
  return isPositiveIntString(num);
}

function isDocType(s: string): s is DocType {
  return DOC_TYPES.has(s as DocType);
}

function isChildType(s: string): s is ChildType {
  return CHILD_TYPES.has(s as ChildType);
}

function fail(input: string, reason: string): RefParseResult {
  return { ok: false, reason, input };
}

export function parseRef(input: string): RefParseResult {
  if (typeof input !== "string") {
    return fail(String(input), "input must be a string");
  }
  if (input.length === 0) {
    return fail(input, "empty input");
  }
  // Reject leading/trailing slashes outright — canonical refs have none.
  if (input.startsWith("/")) {
    return fail(input, "leading slash not allowed");
  }
  if (input.endsWith("/")) {
    return fail(input, "trailing slash not allowed");
  }
  // No whitespace anywhere.
  if (/\s/.test(input)) {
    return fail(input, "whitespace not allowed");
  }

  const parts = input.split("/");
  // Allowed shapes: 4 segments (doc only) or 6 segments (doc + child).
  if (parts.length !== 4 && parts.length !== 6) {
    return fail(
      input,
      `expected 4 or 6 path segments, got ${parts.length}`,
    );
  }

  // Empty segments would only arise if the split saw `//`; surface it.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length === 0) {
      return fail(input, `empty segment at position ${i}`);
    }
  }

  const [namespace, memex, docType, docHandle, childType, childHandle] = parts;

  if (!SLUG_RE.test(namespace)) {
    return fail(input, `invalid namespace slug: "${namespace}"`);
  }
  if (!SLUG_RE.test(memex)) {
    return fail(input, `invalid memex slug: "${memex}"`);
  }
  if (!isDocType(docType)) {
    return fail(input, `unknown doc type: "${docType}"`);
  }

  const expectedDocPrefix = DOC_HANDLE_PREFIX[docType];
  if (!isValidHandle(docHandle, expectedDocPrefix)) {
    return fail(
      input,
      `invalid handle "${docHandle}" for doc type "${docType}" — expected "${expectedDocPrefix}-N"`,
    );
  }

  const ref: ParsedRef = {
    namespace,
    memex,
    docType,
    docHandle,
  };

  if (parts.length === 6) {
    if (!isChildType(childType)) {
      return fail(input, `unknown child type: "${childType}"`);
    }
    const expectedChildPrefix = CHILD_HANDLE_PREFIX[childType];
    if (!isValidHandle(childHandle, expectedChildPrefix)) {
      return fail(
        input,
        `invalid handle "${childHandle}" for child type "${childType}" — expected "${expectedChildPrefix}-N"`,
      );
    }
    ref.child = { type: childType, handle: childHandle };
  }

  return { ok: true, ref };
}

export function formatRef(ref: ParsedRef): string {
  const base = `${ref.namespace}/${ref.memex}/${ref.docType}/${ref.docHandle}`;
  if (ref.child) {
    return `${base}/${ref.child.type}/${ref.child.handle}`;
  }
  return base;
}
