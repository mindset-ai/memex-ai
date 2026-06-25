// Back-end outcome sink (spec-244 t-3 / dec-8).
//
// A bus subscriber — sibling to the activity-log sink — that mirrors a WHITELISTED
// subset of mutate() ChangeEvents into usage_events, so funnels see confirmed
// OUTCOMES (document.created), not just front-end INTENTS (spec.create_clicked).
//
// The whitelist is DERIVED from the registry (dec-5 single source of truth): each
// back-end registry entry is named exactly `${entity}.${action}`, so a bus event
// is whitelisted iff `${event.entity}.${event.action}` is a registered back-end
// name. Adding a back-end outcome = adding one registry entry (the symmetric
// two-line ergonomic, spec-244 §Design). Non-whitelisted events are never written.
//
// Single-writer (localOnly, the spec-156 relay rule): the durable mirror runs
// exactly once at the origin instance, never on relayed foreign events.

import { BACKEND_EVENT_NAMES, sanitizeUsageProps } from "@memex/shared";
import { bus, type ChangeEvent, type Unsubscribe } from "./bus.js";
import { recordUsageEvent } from "./usage-events.js";

const WHITELIST: ReadonlySet<string> = new Set(BACKEND_EVENT_NAMES);

/** The usage-event name for a bus event: `${entity}.${action}`. */
export function backendEventName(event: ChangeEvent): string {
  return `${event.entity}.${event.action}`;
}

/** True iff this bus event is a whitelisted back-end outcome (dec-8). */
export function isWhitelistedOutcome(event: ChangeEvent): boolean {
  return WHITELIST.has(backendEventName(event));
}

let unsubscribe: Unsubscribe | null = null;

/**
 * Register the back-end outcome sink against the bus. Idempotent (latch), like the
 * activity-log sink. localOnly so the row is written exactly once at the origin
 * instance (never on cross-instance relayed events). Wired once at startup from
 * index.ts, alongside startActivityLogSink().
 */
export function startUsageBackendSink(): Unsubscribe {
  if (unsubscribe) return unsubscribe;
  unsubscribe = bus.subscribe(
    {},
    (event) => {
      if (!isWhitelistedOutcome(event)) return;
      if (typeof event.memexId !== "string" || event.memexId.length === 0) return;
      // Detached + advisory: recordUsageEvent swallows its own failures; the extra
      // catch guards the bus dispatch path from any synchronous throw.
      void recordUsageEvent({
        memexId: event.memexId,
        actorUserId: event.actorUserId ?? event.userId ?? null,
        name: backendEventName(event),
        source: "backend",
        props: sanitizeUsageProps(event.payload),
      }).catch(() => {
        /* advisory — never disturb the emitter */
      });
    },
    { localOnly: true },
  );
  return unsubscribe;
}

/** Tear down the sink. Test-only — production registers once per process lifetime. */
export function _stopUsageBackendSink(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}
