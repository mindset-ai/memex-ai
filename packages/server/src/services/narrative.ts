import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, docSections } from "../db/schema.js";
import type { Decision, DocSection } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { isSpecNarrativeStale } from "@memex/shared";

// Re-export the cross-surface staleness predicate so server callers that
// don't want the full `assessNarrativeFreshness` fact sheet still go through
// a single source of truth.
export { isSpecNarrativeStale };

// Doc-12 t-4 — narrative-freshness assessment + consolidation marker.
//
// The agent can ask "has the Spec narrative been kept in sync with recent
// decisions and section edits?" — assess_narrative_freshness compares
// `documents.narrativeLastConsolidatedAt` against decisions.updatedAt /
// docSections.updatedAt. After consolidating, the agent calls
// mark_narrative_consolidated to stamp the column.

export interface NarrativeFreshness {
  briefId: string;
  specHandle: string;
  specTitle: string;
  lastConsolidatedAt: Date | null;
  /** Decisions whose state changed after the last consolidation (or all decisions if never consolidated). */
  changedDecisions: {
    handle: string;
    title: string;
    status: string;
    /** decisions has no `updated_at`; we use `resolvedAt` if present, else `createdAt`. */
    lastChangedAt: Date;
  }[];
  /** Sections whose content was updated after the last consolidation (or all sections if never consolidated). */
  changedSections: {
    sectionType: string;
    title: string | null;
    updatedAt: Date;
  }[];
  /** Short narrative the agent can read aloud — summarises the deltas. */
  factSheet: string;
}

async function loadSpec(memexId: string, briefId: string) {
  const spec = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!spec) {
    throw new NotFoundError(`Spec ${briefId} not found`);
  }
  if (spec.docType !== "spec") {
    throw new ValidationError(
      `Narrative tools are Spec-only (docType='${spec.docType}').`,
    );
  }
  return spec;
}

/**
 * Compare the Spec's narrative consolidation timestamp against decision /
 * section activity and report what's been touched since.
 *
 * Spec-only — non-Spec docTypes throw ValidationError. Decisions don't
 * carry an `updated_at` column today, so we approximate "decision changed
 * recently" by `resolvedAt ?? createdAt`. Good enough for the agent's
 * "what's drifted" check; if it ever needs to be tighter we add a column.
 */
export async function assessNarrativeFreshness(
  memexId: string,
  briefId: string,
): Promise<NarrativeFreshness> {
  const spec = await loadSpec(memexId, briefId);

  const allDecisions: Decision[] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.docId, briefId), eq(decisions.memexId, memexId)));

  const allSections: DocSection[] = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, briefId));

  const last = spec.narrativeLastConsolidatedAt;

  // "When did this decision last change?" — best-effort: resolvedAt > createdAt.
  const decisionChangeTime = (d: Decision): Date => d.resolvedAt ?? d.createdAt;

  // Staleness rule lives in @memex/shared/spec-readiness so the React UI
  // and the server agree on what "newer than the consolidation anchor" means.
  // We re-export `isSpecNarrativeStale` for any caller that wants the boolean
  // without a per-row list; the per-row projection here is needed for the
  // agent fact sheet.
  const changedDecisions = allDecisions
    .filter((d) => last === null || decisionChangeTime(d) > last)
    .map((d) => ({
      handle: `dec-${d.seq}`,
      title: d.title,
      status: d.status,
      lastChangedAt: decisionChangeTime(d),
    }));

  const changedSections = allSections
    .filter((s) => last === null || (s.updatedAt && s.updatedAt > last))
    .map((s) => ({
      sectionType: s.sectionType,
      title: s.title,
      updatedAt: s.updatedAt,
    }));

  // Compose the agent-readable fact sheet.
  const lastStr = last ? last.toISOString() : "never";
  const lines: string[] = [];
  lines.push(
    `Spec ${spec.handle} "${spec.title}" — narrative last consolidated: ${lastStr}.`,
  );
  if (last === null) {
    lines.push(
      "The narrative has not been consolidated yet. All decisions and sections are 'new' from this tool's perspective.",
    );
  }
  lines.push(
    `Since then: ${changedDecisions.length} decision${changedDecisions.length === 1 ? "" : "s"} changed, ${changedSections.length} section${changedSections.length === 1 ? "" : "s"} updated.`,
  );
  if (changedDecisions.length === 0 && changedSections.length === 0) {
    lines.push("Narrative is fresh — nothing has changed since the last consolidation.");
  }
  const factSheet = lines.join(" ");

  return {
    // `briefId` field name preserved under the b-105 wire-format allowlist.
    briefId: spec.id,
    specHandle: spec.handle,
    specTitle: spec.title,
    lastConsolidatedAt: last,
    changedDecisions,
    changedSections,
    factSheet,
  };
}

export interface NarrativeConsolidation {
  briefId: string;
  specHandle: string;
  consolidatedAt: Date;
}

/**
 * Stamp `narrativeLastConsolidatedAt = now()` on the Spec. Called by the
 * agent after rewriting the narrative to capture the consequences of recent
 * decisions and edits.
 *
 * Spec-only — non-Spec docTypes throw ValidationError.
 */
export async function markNarrativeConsolidated(
  memexId: string,
  briefId: string,
): Promise<Mutated<NarrativeConsolidation>> {
  const spec = await loadSpec(memexId, briefId);
  const now = new Date();

  return mutate(
    {},
    { memexId, docId: spec.id, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({ narrativeLastConsolidatedAt: now })
        .where(and(eq(documents.id, briefId), eq(documents.memexId, memexId)))
        .returning();

      return {
        // `briefId` field name preserved under the b-105 wire-format allowlist.
        briefId: updated.id,
        specHandle: updated.handle,
        consolidatedAt: now,
      };
    },
  );
}
