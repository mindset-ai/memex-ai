// Usage-events forwarder (spec-244 dec-3) — the DB-as-outbox drain.
//
// Tails usage_events WHERE forwarded_at IS NULL, micro-batches the rows to the
// configured AnalyticsSink, and stamps forwarded_at on success. The cursor IS the
// table: at-least-once delivery that survives a Cloud Run restart (an un-stamped
// batch is simply re-read next tick). If the sink throws, forwarded_at is left
// unset and the batch retries — never double-stamped on a partial failure.
//
// In-process loop (dec-3 — at ~77K events/month a scheduler is overkill). If no
// sink is configured (no MIXPANEL_TOKEN), forwarding is OFF and capture still works
// standalone (rollout step one: events queryable in SQL before any sink exists).

import { asc, inArray, isNull } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import type { AnalyticsSink } from "./analytics-sink.js";
import { MixpanelSink } from "./mixpanel-sink.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[usage-forwarder]", ...args);
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Resolve the configured sink from the environment, or null when forwarding is
 * disabled. Mixpanel is the default (dec-2): the per-env project token is the
 * MIXPANEL_TOKEN value injected from Secret Manager (memex-int token in int,
 * memex-prod token in prod — dec-9). No token ⇒ capture-only.
 */
export function configuredSink(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): AnalyticsSink | null {
  const token = env.MIXPANEL_TOKEN?.trim();
  if (!token) return null;
  return new MixpanelSink(token, fetchImpl);
}

/**
 * Drain one batch. Returns the number of rows forwarded. Reads the oldest
 * undrained rows, ships them, and stamps forwarded_at only after send() resolves —
 * a thrown send leaves the batch undrained for the next tick (at-least-once).
 */
export async function drainOnce(
  sink: AnalyticsSink,
  batchSize: number = DEFAULT_BATCH_SIZE,
  conn: Db = db,
): Promise<number> {
  const batch = await conn
    .select()
    .from(usageEvents)
    .where(isNull(usageEvents.forwardedAt))
    .orderBy(asc(usageEvents.occurredAt))
    .limit(batchSize);
  if (batch.length === 0) return 0;

  // Throws on failure → forwarded_at stays NULL → retried next tick.
  await sink.send(batch);

  await conn
    .update(usageEvents)
    .set({ forwardedAt: new Date() })
    .where(
      inArray(
        usageEvents.id,
        batch.map((r) => r.id),
      ),
    );
  return batch.length;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the in-process forwarder loop. No-op (logged) when no sink is configured.
 * Wired once at startup from index.ts. The timer is .unref()'d so it never keeps
 * the process alive during shutdown.
 */
export function startUsageForwarder(opts?: {
  intervalMs?: number;
  batchSize?: number;
  sink?: AnalyticsSink | null;
}): void {
  if (timer) return;
  const sink = opts?.sink ?? configuredSink();
  if (!sink) {
    log("no analytics sink configured (MIXPANEL_TOKEN unset) — capture-only, forwarding disabled");
    return;
  }
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  log(`forwarding to ${sink.name} every ${intervalMs}ms (batch ${batchSize})`);
  timer = setInterval(() => {
    void drainOnce(sink, batchSize).catch((err) => {
      // Advisory: a failed drain just retries next tick. Loud but non-fatal.
      log("drain failed (will retry next tick):", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
  timer.unref?.();
}

/** Stop the forwarder loop. Test-only / shutdown. */
export function stopUsageForwarder(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
