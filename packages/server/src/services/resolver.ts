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
  // spec-521 dec-2 (ac-12): `archivedParent` marks a child-ref miss caused by the
  // PARENT being archived rather than the child being absent. It exists for
  // server-side observability only (std-7 cl-6/cl-7 — the server may record what
  // the response must not leak). `reason` is deliberately set to the byte-identical
  // string a genuinely-absent doc produces, so the caller-visible message cannot
  // distinguish the two cases. Never branch on this flag to change the response.
  | { notFound: true; reason: string; archivedParent?: true }
  // spec-521 dec-2 (ac-2): the DOC's own ref resolved to an archived document. The
  // row rides along so the calling surface can render the stub without re-querying;
  // it must serve nothing from it beyond the six stub facts.
  | { archivedDoc: true; doc: Doc };

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
  const docNotFoundReason = `doc_not_found: ${ref.docType}/${ref.docHandle} in ${ref.namespace}/${ref.memex}`;
  if (!doc) {
    return fallback(originalPath, docNotFoundReason);
  }

  // 4a. spec-521 dec-1 (ac-11) — THE ARCHIVED GUARD. Archive must mean forget.
  //
  // This function had no archived check at all, which was the entire defect: every
  // doc-targeting agent tool (list_acs, get_ac, list_tasks, list_comments,
  // get_issue, get_test_matrix, assess_spec — and every mutating handler) resolves
  // its ref through here, so an archived Spec's decisions and ACs were served in
  // full to both agent surfaces and could still be written to.
  //
  // WHY HERE, ONCE, WITH NO OPT-IN PARAMETER (dec-1). This function has exactly two
  // value importers — agent/tools.ts (the in-app agent) and mcp/tools.ts (the coding
  // agent) — and BOTH are surfaces that must be blocked. There is no third caller to
  // over-block: the 35 REST route files import middleware/memex-resolver.js (an
  // unrelated tenant resolver), and the web UI reads content through
  // routes/documents.ts → getDoc/listDocs, which take an explicit `includeArchived`
  // and are untouched by this guard. So the archive view and the Pulse rows keep
  // working. An `includeArchived` escape hatch here would be dead code on day one.
  //
  // The duplicated `isDemo` guard in both surfaces is explicitly NOT the precedent
  // (dec-1): a demo Spec must stay visible to the BOARD, so a shared-resolver guard
  // would have been wrong for it. Archived docs have no such exception — and the
  // `archivedAt` twin of that guard never being written is how this bug was born.
  //
  // TWO GRAINS (dec-2), and the asymmetry is deliberate — see formatArchivedDocStub.
  if (doc.archivedAt) {
    if (ref.child) {
      // Child grain → indistinguishable from a ref that never existed. We reuse the
      // EXACT reason string the `!doc` branch above produces, because both agent
      // surfaces interpolate `reason` into their NotFoundError message; a bespoke
      // reason here (`archived_parent: …`) would leak the parent's archived state
      // through the error text and break ac-12. `archivedParent` carries that fact
      // out-of-band for logging instead.
      //
      // No redirect fallback: unlike a real miss there is nothing to redirect TO —
      // the doc exists, we are refusing to serve it.
      return { notFound: true, reason: docNotFoundReason, archivedParent: true };
    }
    return { archivedDoc: true, doc };
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
