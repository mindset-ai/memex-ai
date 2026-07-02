// spec-427 t-9 (ac-6) — activation drip success-metric measurability.
//
// Joins comms_log (the send, recorded under its stable template key with sent_at) with
// the funnel signals to compute per-cohort send→success conversion — the feedback loop
// that tells us whether the drip moves the ~60% return-to-spec needle. Success metrics:
//   • Email 1 (connected_inactive): a `mcp.tool_called` within 24h of send. The cohort
//     gate guarantees no prior tool call, so "a tool call in-window" == "FIRST tool call
//     within 24h" (ac-6).
//   • Email 2 (signed_in_dormant): `mcp.connected` AND a spec created, BOTH within 48h.
//
// "spec created" is sourced from the `documents` table (created_by_user_id / doc_type /
// created_at) — the same source `hasSpec` uses (journey-state.ts) — because there is no
// spec-created funnel event in usage_events (the narrative's "usage_events funnel events"
// is inaccurate for this half; flagged as drift on the Spec). No new instrumentation:
// this rides comms_log + existing funnel events + documents.
//
// SCOPE / RLS: this is a REPORTING/OPS helper. `documents` is the only RLS table in the
// join (comms_log is RLS-excluded, usage_events has no RLS). A context-less cross-user
// read of `documents` under the runtime `memex_app` role would filter toward zero, so
// run this in an OWNER/ADMIN context (the same posture as the db:backfill-* scripts) —
// e.g. from a prod shell with an owner DATABASE_URL. Pass `userIds` to scope the report
// to a specific set of recipients (also what the tests use for determinism).

import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { type Db, db } from "../../db/connection.js";
import { commsLog, usageEvents, documents } from "../../db/schema.js";
import { ACTIVATION_COMMS_KEY } from "./activation-drip.js";
import { type ActivationCohort } from "../activation-cohort.js";

export interface CohortConversion {
  cohort: ActivationCohort;
  /** Activation emails of this cohort recorded in comms_log with a send time. */
  sent: number;
  /** Of those, how many hit the cohort's success metric within its window. */
  converted: number;
  /** converted / sent, or 0 when nothing was sent (never NaN). */
  rate: number;
}

// A funnel event by this recipient within [sent_at, sent_at + N hours]. Column/table
// identifiers are interpolated via Drizzle so they render fully-qualified; the interval
// is a literal, correlating to the outer comms_log row.
function eventInWindow(name: string, hours: number): SQL {
  return sql`exists (
    select 1 from ${usageEvents}
    where ${usageEvents.actorUserId} = ${commsLog.userId}
      and ${usageEvents.name} = ${name}
      and ${usageEvents.occurredAt} >= ${commsLog.sentAt}
      and ${usageEvents.occurredAt} <= ${commsLog.sentAt} + (${hours} * interval '1 hour')
  )`;
}

// A non-demo Spec authored by this recipient within [sent_at, sent_at + N hours].
function specCreatedInWindow(hours: number): SQL {
  return sql`exists (
    select 1 from ${documents}
    where ${documents.createdByUserId} = ${commsLog.userId}
      and ${documents.docType} = 'spec'
      and ${documents.isDemo} = false
      and ${documents.createdAt} >= ${commsLog.sentAt}
      and ${documents.createdAt} <= ${commsLog.sentAt} + (${hours} * interval '1 hour')
  )`;
}

async function countCohort(
  conn: Db,
  cohort: ActivationCohort,
  convertedWhen: SQL,
  userIds: string[] | undefined,
): Promise<CohortConversion> {
  // An explicit empty scope means "no one" — short-circuit to zeros (inArray([]) is a
  // no-match, but being explicit keeps the intent obvious).
  if (userIds && userIds.length === 0) {
    return { cohort, sent: 0, converted: 0, rate: 0 };
  }
  const where = [
    eq(commsLog.channel, "email"),
    eq(commsLog.type, ACTIVATION_COMMS_KEY[cohort]),
    isNotNull(commsLog.sentAt),
    ...(userIds ? [inArray(commsLog.userId, userIds)] : []),
  ];
  const [row] = await conn
    .select({
      sent: sql<number>`count(*)::int`,
      converted: sql<number>`count(*) filter (where ${convertedWhen})::int`,
    })
    .from(commsLog)
    .where(and(...where));
  const sent = row?.sent ?? 0;
  const converted = row?.converted ?? 0;
  return { cohort, sent, converted, rate: sent === 0 ? 0 : converted / sent };
}

/**
 * Per-cohort send→success conversion for the activation drip (ac-6). Returns one row per
 * cohort. Pass `userIds` to scope the report to specific recipients (else all-time,
 * all-users). See the RLS note at the top of the file re: running context.
 */
export async function measureActivationConversion(
  conn: Db = db,
  opts: { userIds?: string[] } = {},
): Promise<CohortConversion[]> {
  const e1 = await countCohort(
    conn,
    "connected_inactive",
    eventInWindow("mcp.tool_called", 24),
    opts.userIds,
  );
  const e2 = await countCohort(
    conn,
    "signed_in_dormant",
    sql`(${eventInWindow("mcp.connected", 48)} and ${specCreatedInWindow(48)})`,
    opts.userIds,
  );
  return [e1, e2];
}
