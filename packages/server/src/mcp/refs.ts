// b-36 T-6 — MCP-side ref helpers.
//
// Layered on top of `services/refs.ts` (the canonical-ref grammar) and
// `services/resolver.ts` (the entity resolver) — this file is the place
// MCP-tool code reaches into when it needs to:
//
//   1. Reject raw UUID inputs at the tool boundary (D-7 of b-36).
//   2. Compose canonical ref strings for a resolved doc / section / decision /
//      task / comment so formatter output can lead with `ref: <path>`.
//   3. Parse the `memex` arg (`<namespace>/<memex>`) into its two slugs.
//
// Keep this thin: parsing / formatting / boundary asserts only. Database work
// lives in `services/resolver.ts`.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, type Doc } from "../db/schema.js";
import { formatRef, type DocType, type ChildType, type ParsedRef } from "../services/refs.js";
import { ValidationError } from "../types/errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Tool-boundary guard. UUID inputs are no longer accepted on the MCP surface
 * after b-36 (D-7); callers must pass canonical refs. The error message is
 * load-bearing — tests look for "UUID inputs no longer accepted".
 */
export function assertRefNotUuid(value: string, argName = "ref"): void {
  if (typeof value !== "string") return;
  if (UUID_RE.test(value)) {
    throw new ValidationError(
      `UUID inputs no longer accepted; pass the ref. (${argName}=${value.slice(0, 8)}…)`,
    );
  }
}

/**
 * Parse `<namespace>/<memex>` into its two slugs. Tolerates leading/trailing
 * whitespace; rejects anything that doesn't have exactly one '/'.
 */
export function parseMemexArg(memex: string): { namespace: string; memex: string } {
  const trimmed = (memex ?? "").trim();
  const slash = trimmed.indexOf("/");
  if (slash < 1 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    throw new Error(
      `Invalid memex identifier "${memex}". Expected \`<namespace>/<memex>\` (e.g. "mindset/website-rewrite").`,
    );
  }
  return { namespace: trimmed.slice(0, slash), memex: trimmed.slice(slash + 1) };
}

// ── Compose canonical refs from rows ──────────────────────────────────────
//
// The resolver returns entity rows directly but stops short of composing the
// canonical path string. Formatters need that string to lead with
// `ref: <path>` per D-8. We derive the path from:
//   * the namespace.slug + memex.slug pair (one query per memex, cached per
//     call by the helper below — formatters can rely on a single fetch even
//     when emitting many entries from the same memex)
//   * doc.docType + doc.handle  →  /<doc-type>/<handle>
//   * child.seq + child kind   →  /<child-type>/<prefix>-<seq>

// Per b-105 dec-3 / ac-10: the only doc_type → URL mapping for the Spec
// docType is `spec → /specs`. Legacy aliases are removed entirely — migration
// 0063 sweeps stored rows over to `doc_type = 'spec'` before this code runs,
// so no fallback bucket is needed.
const DB_DOC_TYPE_TO_URL: Record<string, DocType> = {
  spec: "specs",
  document: "docs",
  standard: "standards",
  execution_plan: "execution-plans",
};

export function docTypeForUrl(dbDocType: string): DocType {
  const mapped = DB_DOC_TYPE_TO_URL[dbDocType];
  if (!mapped) {
    // Defensive — keep formatters from crashing on a doc with a previously
    // unknown type. Bucket into /docs which is the catch-all path.
    return "docs";
  }
  return mapped;
}

export const CHILD_PREFIX_BY_KIND: Record<ChildType, string> = {
  sections: "s",
  decisions: "dec",
  tasks: "t",
  comments: "c",
  acs: "ac",
  issues: "issue",
  clauses: "cl",
};

/**
 * Look up `{ namespace, memex }` slugs for a given memexId. One DB round
 * trip; callers that build many refs from the same memex should cache the
 * result across calls.
 */
export async function memexSlugsById(
  memexId: string,
): Promise<{ namespace: string; memex: string } | null> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return null;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns) return null;
  return { namespace: ns.slug, memex: memex.slug };
}

/**
 * Build a canonical ref string for a doc row given its namespace/memex slugs.
 * Pure — no DB work. Caller supplies the slugs (via `memexSlugsById` or via
 * the resolver's `parsedRef.namespace` / `parsedRef.memex`).
 */
export function buildDocRef(
  slugs: { namespace: string; memex: string },
  doc: Pick<Doc, "docType" | "handle">,
): string {
  const ref: ParsedRef = {
    namespace: slugs.namespace,
    memex: slugs.memex,
    docType: docTypeForUrl(doc.docType),
    docHandle: doc.handle,
  };
  return formatRef(ref);
}

/**
 * Build a canonical child ref for a section/decision/task/comment underneath
 * a doc, given the resolved doc + the child's `seq`.
 */
export function buildChildRef(
  slugs: { namespace: string; memex: string },
  doc: Pick<Doc, "docType" | "handle">,
  child: { type: ChildType; seq: number },
): string {
  const prefix = CHILD_PREFIX_BY_KIND[child.type];
  const ref: ParsedRef = {
    namespace: slugs.namespace,
    memex: slugs.memex,
    docType: docTypeForUrl(doc.docType),
    docHandle: doc.handle,
    child: { type: child.type, handle: `${prefix}-${child.seq}` },
  };
  return formatRef(ref);
}
