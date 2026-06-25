// Ref-building concern (spec-363 sol-7: god-module split). Canonical URL path
// construction + docType→kind mapping. No DB, no ranking, no formatting — pure
// string/path logic. Moved verbatim from memex-search.ts.

import type { MemexSearchKind, MemexSlugs } from "./types.js";

// docType → URL path segment. Matches the routing convention: specs at
// /specs, standards at /standards, free-form at /docs, execution plans at
// /execution-plans.
export function docTypeToPathSegment(docType: string): string {
  if (docType === "spec") return "specs";
  if (docType === "standard") return "standards";
  if (docType === "execution_plan") return "execution-plans";
  return "docs"; // document, adr, runbook, etc.
}

export function buildDocPath(slugs: MemexSlugs, docType: string, handle: string): string {
  return `${slugs.namespace_slug}/${slugs.memex_slug}/${docTypeToPathSegment(docType)}/${handle}`;
}

export function buildDecisionPath(
  slugs: MemexSlugs,
  parentDocType: string,
  parentHandle: string,
  decSeq: number,
): string {
  return `${buildDocPath(slugs, parentDocType, parentHandle)}/decisions/dec-${decSeq}`;
}

// Issues hang off a Spec under `/issues/issue-N`, mirroring how decisions hang off
// `/decisions/dec-N` (spec-112 t-4). The `issue-N` handle is the per-Spec issue seq
// minted by services/issues.ts — same shape rule as dec-N (renamed from `i-N` per
// spec-158 dec-3).
export function buildIssuePath(
  slugs: MemexSlugs,
  parentDocType: string,
  parentHandle: string,
  issueSeq: number,
): string {
  return `${buildDocPath(slugs, parentDocType, parentHandle)}/issues/issue-${issueSeq}`;
}

export function kindForDocType(docType: string): MemexSearchKind {
  if (docType === "spec") return "spec";
  if (docType === "standard") return "standard";
  return "document";
}
