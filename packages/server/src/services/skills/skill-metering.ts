// spec-300 t-5 — Skills usage metering (dec-21).
//
// A `get_skill` BODY fetch is the signal of intent-to-use: the service records
// exactly ONE usage event per body fetch (never on a `list_skills` appearance —
// that would inflate every skill equally). The event carries WHAT (the skill ref
// + handle + doc id), the working-Spec ref it was pulled in service of, WHO (the
// actor), HOW (the channel — in-app vs coding agent vs REST), and WHEN (the
// occurrence timestamp). It rides the EXISTING usage-events store (std-35): a
// DIRECT recordUsageEvent() call — the same delivery:'direct' path account.created
// / mcp.tool_called use — because a read is not a mutate() bus outcome. No new
// table: `usage_events` already carries memex_id + actor_user_id + name + props
// (jsonb) + occurred_at, which is everything the hot/cold report needs.
//
// Advisory by construction: recordUsageEvent swallows its own failures, so a
// metering hiccup never breaks a Skill read.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { documents, memexes, namespaces, usageEvents } from "../../db/schema.js";
import type { RequestCtx } from "../mutate.js";
import { recordUsageEvent } from "../usage-events.js";

/** The registered (std-35) event name for a Skill body fetch. delivery:'direct'. */
export const SKILL_USED_EVENT = "skill.used";

const SKILL_DOC_TYPE = "skill";

// ── Record a use (advisory) ────────────────────────────────────────────────────

export interface RecordSkillUseInput {
  readonly memexId: string;
  /** The Skill document's id — the stable aggregation key. */
  readonly skillDocId: string;
  /** The `skill-N` handle — the human-legible, memex-unique join key. */
  readonly skillHandle: string;
  /** The canonical Skill ref, recorded for display + Mixpanel. */
  readonly skillRef: string;
  /** The Spec ref this read served, when supplied (the inverse-view key). */
  readonly workingSpecRef?: string;
  /** Carries WHO (actorUserId) + HOW (channel) onto the event. */
  readonly ctx?: RequestCtx;
}

/**
 * Emit exactly one `skill.used` usage event for a Skill body fetch. Advisory:
 * delegates to recordUsageEvent, which logs-and-swallows any failure so a read is
 * never disrupted. Props carry IDs / enums / a ref only — never content (std-35).
 */
export async function recordSkillUse(input: RecordSkillUseInput): Promise<void> {
  const ctx = input.ctx ?? {};
  const props: Record<string, unknown> = {
    skill_id: input.skillDocId,
    skill_handle: input.skillHandle,
    skill_ref: input.skillRef,
  };
  if (input.workingSpecRef) props.working_spec_ref = input.workingSpecRef;
  if (ctx.channel) props.channel = ctx.channel;

  await recordUsageEvent({
    memexId: input.memexId,
    actorUserId: ctx.actorUserId ?? null,
    name: SKILL_USED_EVENT,
    source: "backend",
    props,
  });
}

// ── Reporting ──────────────────────────────────────────────────────────────────

/** One row of the hot/cold report — a Skill and how often it has been pulled. */
export interface SkillUsageReportItem {
  readonly ref: string;
  readonly handle: string;
  readonly name: string;
  /** Total `skill.used` events for this Skill in the Memex (0 for a cold skill). */
  readonly useCount: number;
  /** The most recent pull, or null when the Skill has never been fetched. */
  readonly lastUsedAt: Date | null;
}

/** The per-handle use aggregate over `skill.used` events, optionally spec-scoped. */
function skillUseAggregate(memexId: string, workingSpecRef?: string) {
  const filters = [
    eq(usageEvents.memexId, memexId),
    eq(usageEvents.name, SKILL_USED_EVENT),
  ];
  if (workingSpecRef !== undefined) {
    filters.push(sql`${usageEvents.props} ->> 'working_spec_ref' = ${workingSpecRef}`);
  }
  return db
    .select({
      handle: sql<string>`${usageEvents.props} ->> 'skill_handle'`.as("used_handle"),
      useCount: sql<number>`count(*)::int`.as("use_count"),
      lastUsedAt: sql<Date>`max(${usageEvents.occurredAt})`.as("last_used_at"),
    })
    .from(usageEvents)
    .where(and(...filters))
    .groupBy(sql`${usageEvents.props} ->> 'skill_handle'`)
    .as("uses");
}

/**
 * The hot/cold report: EVERY active Skill in the Memex ranked most-used → least-used,
 * so both the hot skills and the cold ones (use_count 0, never fetched) are visible.
 * Ties break alphabetically by name. Powers the list-page hot/cold indicator (dec-21).
 */
export async function getSkillUsageReport(memexId: string): Promise<SkillUsageReportItem[]> {
  const uses = skillUseAggregate(memexId);
  const rows = await db
    .select({
      handle: documents.handle,
      title: documents.title,
      namespaceSlug: namespaces.slug,
      memexSlug: memexes.slug,
      useCount: sql<number>`coalesce(${uses.useCount}, 0)`,
      lastUsedAt: uses.lastUsedAt,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .leftJoin(uses, eq(uses.handle, documents.handle))
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, SKILL_DOC_TYPE),
        isNull(documents.archivedAt),
      ),
    )
    .orderBy(desc(sql`coalesce(${uses.useCount}, 0)`), asc(documents.title));

  return rows.map((r) => ({
    ref: `${r.namespaceSlug}/${r.memexSlug}/skills/${r.handle}`,
    handle: r.handle,
    name: r.title,
    useCount: Number(r.useCount),
    lastUsedAt: r.lastUsedAt ?? null,
  }));
}

/**
 * The inverse view (dec-21): given a Spec, which Skills were pulled against it —
 * only Skills actually fetched in service of that Spec, ranked by pull count. Keyed
 * on the `working_spec_ref` prop the get_skill caller threaded through.
 */
export async function getSkillsUsedForSpec(
  memexId: string,
  workingSpecRef: string,
): Promise<SkillUsageReportItem[]> {
  const uses = skillUseAggregate(memexId, workingSpecRef);
  const rows = await db
    .select({
      handle: documents.handle,
      title: documents.title,
      namespaceSlug: namespaces.slug,
      memexSlug: memexes.slug,
      useCount: uses.useCount,
      lastUsedAt: uses.lastUsedAt,
    })
    .from(uses)
    .innerJoin(
      documents,
      and(eq(documents.handle, uses.handle), eq(documents.memexId, memexId)),
    )
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(and(eq(documents.docType, SKILL_DOC_TYPE), isNull(documents.archivedAt)))
    .orderBy(desc(uses.useCount), asc(documents.title));

  return rows.map((r) => ({
    ref: `${r.namespaceSlug}/${r.memexSlug}/skills/${r.handle}`,
    handle: r.handle,
    name: r.title,
    useCount: Number(r.useCount),
    lastUsedAt: r.lastUsedAt ?? null,
  }));
}
