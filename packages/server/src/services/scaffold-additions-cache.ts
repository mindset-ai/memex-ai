// Short-TTL projection cache for per-Org scaffold guidance additions
// (b-68 t-11 / ac-10).
//
// `listOrgScaffoldAdditions` is hit on the hot path of every `assess_brief`
// (t-5) and every rubric-prose composition. Reads are dominated by the same
// `orgId, enabledOnly=true` pair across a flurry of MCP calls within seconds
// of each other, and the underlying data only changes when an admin edits an
// addition via the t-10 REST surface (or any future mutate path). Those edits
// already emit a `org_scaffold_addition` event on the std-8 bus (t-3), so the
// cache stays correct by listening to the bus rather than polling.
//
// Design choices (b-68 t-11):
//   - **TTL = 30s** as a safety net for any non-bus path (cross-instance
//     writes from another Cloud Run instance, manual SQL edits in a console).
//     Bus-driven invalidation is the primary correctness mechanism; the TTL
//     is the floor.
//   - **Key = `${orgId}:${enabledOnly}`** so the two filter modes the t-5
//     consumer uses today don't shadow each other. Future filter expansion
//     would slot into the cache key here.
//   - **Module-level singleton** matching the patterns established by
//     `activity-log.ts` (one bus subscriber registered at process start) and
//     `phase-assessment.ts`'s `recentAssessments` module-level Map. Process-
//     local — fine for a single Cloud Run instance, and the TTL floor handles
//     the cross-instance drift case.
//   - **Resolve org from memexId on every event** rather than baking orgId
//     into the std-8 event payload. The std-8 event surface stays bare per
//     dec-3; we use the same `orgIdForMemex` resolver `phase-assessment.ts`
//     uses on the read path. One extra index lookup per admin edit is
//     negligible compared to the savings on the assess_brief hot path.
//
// Bus wiring is registered by `startScaffoldAdditionsCacheInvalidation()` —
// the `index.ts` orchestrator calls it once at startup, mirroring the
// `startActivityLogSink()` registration immediately above it.

import { bus, type Unsubscribe } from "./bus.js";
import {
  listOrgScaffoldAdditions,
  type ListOrgScaffoldAdditionsFilters,
  type OrgScaffoldAdditionView,
} from "./scaffold-additions.js";
import { orgIdForMemex } from "./shared/memex-ownership.js";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  value: OrgScaffoldAdditionView[];
  expiresAt: number;
}

// Process-local cache, keyed by `${orgId}:${enabledOnly}`. Cleared on bus
// invalidation (for the affected orgId) and on TTL expiry (lazily, at read
// time). Never grows without bound: keys are bounded by the (small) cardinality
// of active orgs and the (2) filter modes.
const cache = new Map<string, CacheEntry>();

function keyFor(orgId: string, filters: ListOrgScaffoldAdditionsFilters): string {
  return `${orgId}:${filters.enabledOnly === true ? "enabled" : "all"}`;
}

// Test instrumentation: counts the underlying DB-touching calls so cache-hit /
// TTL-expiry tests can assert "only one read happened" without spying through
// vitest. Test-only — production code never reads this.
let underlyingReadCount = 0;

/**
 * Cached wrapper over `listOrgScaffoldAdditions`. On hit, returns the cached
 * array directly (callers must NOT mutate the returned array — same contract
 * as the underlying function, which returns a fresh array each call but whose
 * GuidanceBlock entries are also expected to be treated immutably).
 *
 * On miss or expiry, calls through to the underlying read and populates the
 * cache. Errors are NOT cached — a failed read leaves the slot empty so the
 * next call retries against the DB.
 */
export async function listOrgScaffoldAdditionsCached(
  orgId: string,
  filters: ListOrgScaffoldAdditionsFilters = {},
): Promise<OrgScaffoldAdditionView[]> {
  const key = keyFor(orgId, filters);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  // Miss / expired — refresh from source.
  underlyingReadCount++;
  const value = await listOrgScaffoldAdditions(orgId, filters);
  cache.set(key, { value, expiresAt: now + DEFAULT_TTL_MS });
  return value;
}

/**
 * Drop every cached entry for this org (both `enabledOnly` modes). Called
 * from the bus subscriber when an `org_scaffold_addition` event lands for
 * this org's primary memex. Exposed so admin-tooling paths could force a
 * flush — production wiring goes through the bus.
 */
export function invalidateOrgScaffoldAdditionsCache(orgId: string): void {
  // Iterate keys: an org can have multiple entries (one per filter mode).
  // Cardinality is tiny — at most 2 today — so a linear scan is fine.
  for (const key of cache.keys()) {
    if (key.startsWith(`${orgId}:`)) {
      cache.delete(key);
    }
  }
}

// ── Bus wiring ────────────────────────────────────────────────────────────

let unsubscribe: Unsubscribe | null = null;

/**
 * Subscribe to the std-8 bus for `org_scaffold_addition` events and invalidate
 * the per-org cache when one lands. Idempotent — a second call is a no-op so
 * importing this module from multiple places never double-subscribes.
 *
 * Wiring: the orchestrator (`index.ts`) calls this once at startup, alongside
 * `startActivityLogSink()` and `startBusObservability()`. Do NOT call
 * `bus.subscribe(...)` for cache invalidation anywhere else.
 *
 * The std-8 event carries `memexId` (the org's primary memex per t-3's
 * `memexKeyForOrg` resolver) rather than `orgId`. We resolve back via
 * `orgIdForMemex` on every event — one indexed lookup per admin edit, which
 * is negligible. Keeps the std-8 event surface bare.
 */
export function startScaffoldAdditionsCacheInvalidation(): Unsubscribe {
  if (unsubscribe) return unsubscribe;
  unsubscribe = bus.subscribe({ entity: "org_scaffold_addition" }, (event) => {
    // Detached: a slow / failed orgIdForMemex lookup must not block the
    // synchronous bus dispatch path. The .catch() guards against an unhandled
    // rejection in the rare DB-down case.
    void (async () => {
      try {
        // Defensive: a malformed event with an empty memexId can't resolve to
        // an org. Skip rather than swallow a downstream NotFoundError.
        if (!event.memexId) return;
        const orgId = await orgIdForMemex(event.memexId);
        if (orgId) invalidateOrgScaffoldAdditionsCache(orgId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[scaffold-cache] invalidation failed (advisory — swallowed):",
          err instanceof Error ? err.message : err,
        );
      }
    })();
  });
  return unsubscribe;
}

/**
 * Tear down the cache subscriber. Test-only — production registers once for
 * the process lifetime. Resets the idempotency latch so a suite can re-arm.
 */
export function _stopScaffoldAdditionsCacheInvalidation(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

// ── Test-only introspection ──────────────────────────────────────────────

/** @internal Reset cache + counter between tests. Production never calls this. */
export function _resetScaffoldAdditionsCache(): void {
  cache.clear();
  underlyingReadCount = 0;
}

/** @internal Number of underlying `listOrgScaffoldAdditions` calls since last reset. */
export function _getUnderlyingReadCount(): number {
  return underlyingReadCount;
}

/** @internal Default TTL in ms — exposed so tests can advance fake time past it. */
export const _DEFAULT_TTL_MS = DEFAULT_TTL_MS;

/**
 * @internal Force every cached entry into the expired state by stamping
 * `expiresAt = 0`. Used by the TTL-expiry test to simulate the passage of
 * time without `vi.useFakeTimers`, which can deadlock async DB drivers that
 * rely on real setTimeout/setImmediate.
 */
export function _expireAllScaffoldAdditionsCacheEntries(): void {
  for (const entry of cache.values()) {
    entry.expiresAt = 0;
  }
}
