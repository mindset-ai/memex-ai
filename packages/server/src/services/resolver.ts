// b-36 T-5 — canonical-ref → entity resolver.
//
// Given a canonical ref string (or an already-parsed `ParsedRef`), walk
// namespace → memex → doc → optional child, returning the underlying row.
// On any miss, fall through to the redirect layer (T-4); a successful
// redirect surfaces as `{ redirected: true, newRef }` so the caller can
// re-resolve (HTTP 301) without us silently following the chain.
//
// Resolution responsibilities:
//   * Strict ref grammar — bad input is a `notFound` with a `parse_error`
//     reason rather than a thrown exception.
//   * Direct entity lookup using the schema's natural keys:
//       - namespaces.slug → namespaces.id
//       - memexes.(namespace_id, slug) → memexes.id
//       - documents.(memex_id, doc_type, handle) → documents
//       - doc_sections.(doc_id, seq) → doc_sections
//       - decisions.(doc_id, seq) → decisions      (handle derived as `dec-${seq}`)
//       - tasks.(doc_id, seq) → tasks              (handle derived as `t-${seq}`)
//       - doc_comments.(doc_id, seq) → doc_comments
//   * On any miss at any step, call `lookupRedirect` against the original
//     canonical path. A hit returns `{ redirected: true, newRef }`; a miss
//     returns `{ notFound: true, reason }` carrying which step missed so
//     the caller has actionable telemetry.
//
// Out of scope (T-5 is the entry point only):
//   * No access-control check. The caller is responsible for membership /
//     permission enforcement against the returned entity's memex.
//   * No alias / loose-form tolerance. That lives at the chat surface.
//   * No mutation of the underlying entity (resolution is read-only).

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  namespaces,
  memexes,
  documents,
  docSections,
  docComments,
  decisions,
  tasks,
  acs,
  issues,
  standardClauses,
  type Doc,
  type DocSection,
  type DocComment,
  type Decision,
  type Task,
  type Issue,
  type StandardClause,
} from "../db/schema.js";
import type { Ac } from "./acs.js";
import {
  parseRef,
  formatRef,
  type ParsedRef,
  type DocType,
  type ChildType,
} from "./refs.js";
import { lookupRedirect } from "./redirects.js";

// DocType (URL/grammar form) → documents.doc_type (DB value).
//
// Per CLAUDE.md + schema:
//   - specs            → 'spec'
//   - standards        → 'standard'
//   - execution-plans  → 'execution_plan'
//   - docs             → 'document'
//
// Note `docs` and `execution-plans` both use `doc-N` handles but live in
// distinct doc_type rows — the URL grammar already disambiguates, so we
// pass the URL doc_type through unchanged into the WHERE clause.
const DOC_TYPE_TO_DB: Record<DocType, string> = {
  specs: "spec",
  docs: "document",
  standards: "standard",
  "execution-plans": "execution_plan",
};

// Reverse mapping doctype kind → entity discriminant.
const DOC_TYPE_TO_KIND: Record<DocType, "spec" | "doc" | "standard" | "execution-plan"> = {
  specs: "spec",
  docs: "doc",
  standards: "standard",
  "execution-plans": "execution-plan",
};

export type ResolvedEntity =
  | { kind: "spec"; row: Doc }
  | { kind: "doc"; row: Doc }
  | { kind: "standard"; row: Doc }
  | { kind: "execution-plan"; row: Doc }
  | { kind: "section"; row: DocSection; doc: Doc }
  | { kind: "decision"; row: Decision; doc: Doc }
  | { kind: "task"; row: Task; doc: Doc }
  | { kind: "comment"; row: DocComment; doc: Doc }
  | { kind: "ac"; row: Ac; doc: Doc }
  | { kind: "issue"; row: Issue; doc: Doc }
  | { kind: "clause"; row: StandardClause; doc: Doc };

export type ResolveResult =
  | { found: true; entity: ResolvedEntity }
  | { redirected: true; newRef: string }
  | { notFound: true; reason: string };

// Extract the integer suffix from a section/comment handle like `s-3` or
// `c-12`. The ref grammar in T-1 has already validated the form, so this
// is a trivial split + parseInt; the prefix is asserted defensively.
function seqFromChildHandle(handle: string, expectedPrefix: string): number {
  const dash = handle.indexOf("-");
  // parseRef guarantees both pieces exist with the right prefix; keep
  // the assertions as a defence-in-depth so a future grammar change can't
  // silently feed us garbage.
  if (dash < 0) {
    throw new Error(`Malformed child handle "${handle}" (expected "${expectedPrefix}-N")`);
  }
  const prefix = handle.slice(0, dash);
  if (prefix !== expectedPrefix) {
    throw new Error(
      `Child handle prefix mismatch — got "${prefix}", expected "${expectedPrefix}"`,
    );
  }
  const n = parseInt(handle.slice(dash + 1), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Child handle "${handle}" has non-positive sequence`);
  }
  return n;
}

const CHILD_PREFIX: Record<ChildType, string> = {
  sections: "s",
  decisions: "dec",
  tasks: "t",
  comments: "c",
  acs: "ac",
  issues: "issue",
  clauses: "cl",
};

// On any direct-lookup miss, fall through to the redirect table using the
// original canonical path. We never partially "patch up" the input — the
// redirect layer prefix-matches so the full ref (including child segments)
// is the right thing to feed it.
async function fallback(
  originalPath: string,
  reason: string,
): Promise<ResolveResult> {
  const r = await lookupRedirect(originalPath);
  if ("redirected" in r) {
    return { redirected: true, newRef: r.redirected };
  }
  return { notFound: true, reason };
}

export async function resolveRef(
  input: string | ParsedRef,
): Promise<ResolveResult> {
  // 1. Normalise input to (ref, originalPath).
  let ref: ParsedRef;
  let originalPath: string;
  if (typeof input === "string") {
    const parsed = parseRef(input);
    if (!parsed.ok) {
      // Parse errors never reach the redirect layer — a malformed string
      // isn't a path the redirect table could plausibly know about.
      return { notFound: true, reason: `parse_error: ${parsed.reason}` };
    }
    ref = parsed.ref;
    originalPath = input;
  } else {
    ref = input;
    originalPath = formatRef(input);
  }

  // 2. Namespace.slug → namespace row.
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, ref.namespace),
  });
  if (!ns) {
    return fallback(originalPath, `namespace_not_found: ${ref.namespace}`);
  }

  // 3. Memex.(namespace_id, slug) → memex row.
  const memex = await db.query.memexes.findFirst({
    where: and(eq(memexes.namespaceId, ns.id), eq(memexes.slug, ref.memex)),
  });
  if (!memex) {
    return fallback(originalPath, `memex_not_found: ${ref.namespace}/${ref.memex}`);
  }

  // 4. Document.(memex_id, doc_type, handle) → doc row.
  const dbDocType = DOC_TYPE_TO_DB[ref.docType];
  const doc = await db.query.documents.findFirst({
    where: and(
      eq(documents.memexId, memex.id),
      eq(documents.docType, dbDocType),
      eq(documents.handle, ref.docHandle),
    ),
  });
  if (!doc) {
    return fallback(
      originalPath,
      `doc_not_found: ${ref.docType}/${ref.docHandle} in ${ref.namespace}/${ref.memex}`,
    );
  }

  // 5. Doc-only ref — return immediately.
  if (!ref.child) {
    const kind = DOC_TYPE_TO_KIND[ref.docType];
    return { found: true, entity: { kind, row: doc } as ResolvedEntity };
  }

  // 6. Child resolution. parseRef has already validated the child handle's
  // prefix matches its type; we double-check defensively here.
  const child = ref.child;
  const expectedPrefix = CHILD_PREFIX[child.type];

  switch (child.type) {
    case "sections": {
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const section = await db.query.docSections.findFirst({
        where: and(eq(docSections.docId, doc.id), eq(docSections.seq, seq)),
      });
      if (!section) {
        return fallback(originalPath, `section_not_found: ${child.handle} on doc ${doc.handle}`);
      }
      return { found: true, entity: { kind: "section", row: section, doc } };
    }
    case "decisions": {
      // decisions have no `handle` column — `dec-N` derives from `seq`.
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const decision = await db.query.decisions.findFirst({
        where: and(eq(decisions.docId, doc.id), eq(decisions.seq, seq)),
      });
      if (!decision) {
        return fallback(originalPath, `decision_not_found: ${child.handle} on doc ${doc.handle}`);
      }
      return { found: true, entity: { kind: "decision", row: decision, doc } };
    }
    case "tasks": {
      // tasks have no `handle` column — `t-N` derives from `seq`.
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.docId, doc.id), eq(tasks.seq, seq)),
      });
      if (!task) {
        return fallback(originalPath, `task_not_found: ${child.handle} on doc ${doc.handle}`);
      }
      return { found: true, entity: { kind: "task", row: task, doc } };
    }
    case "comments": {
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const comment = await db.query.docComments.findFirst({
        where: and(eq(docComments.docId, doc.id), eq(docComments.seq, seq)),
      });
      if (!comment) {
        return fallback(originalPath, `comment_not_found: ${child.handle} on doc ${doc.handle}`);
      }
      return { found: true, entity: { kind: "comment", row: comment, doc } };
    }
    case "acs": {
      // acs have no `handle` column — `ac-N` derives from `seq`. Tenancy is via
      // brief_id (not doc_id like the others), but since this branch only
      // resolves children of a spec doc, doc.id IS the brief_id.
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const ac = await db.query.acs.findFirst({
        where: and(eq(acs.briefId, doc.id), eq(acs.seq, seq)),
      });
      if (!ac) {
        return fallback(originalPath, `ac_not_found: ${child.handle} on spec ${doc.handle}`);
      }
      return { found: true, entity: { kind: "ac", row: ac, doc } };
    }
    case "issues": {
      // issues have no `handle` column — `issue-N` derives from `seq`. Tenancy is via
      // doc_id (the GENERIC column, like tasks/comments — NOT the acs brief_id
      // carve-out); this branch only resolves children of a spec doc, so doc.id
      // IS the issue's parent doc_id (spec-112).
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const issue = await db.query.issues.findFirst({
        where: and(eq(issues.docId, doc.id), eq(issues.seq, seq)),
      });
      if (!issue) {
        return fallback(originalPath, `issue_not_found: ${child.handle} on spec ${doc.handle}`);
      }
      return { found: true, entity: { kind: "issue", row: issue, doc } };
    }
    case "clauses": {
      // standard clauses have no `handle` column — `cl-N` derives from `seq`
      // (allocate-once per standard, spec-150). This branch resolves children of a
      // standard doc, so doc.id IS the clause's doc_id.
      const seq = seqFromChildHandle(child.handle, expectedPrefix);
      const clause = await db.query.standardClauses.findFirst({
        where: and(eq(standardClauses.docId, doc.id), eq(standardClauses.seq, seq)),
      });
      if (!clause) {
        return fallback(originalPath, `clause_not_found: ${child.handle} on standard ${doc.handle}`);
      }
      return { found: true, entity: { kind: "clause", row: clause, doc } };
    }
    default: {
      // Should be unreachable — parseRef rejects unknown child types.
      const _exhaustive: never = child.type;
      return { notFound: true, reason: `unknown_child_type: ${_exhaustive}` };
    }
  }
}
