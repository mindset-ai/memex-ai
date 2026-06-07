// The only legitimate path from a service to the database for tenancy-scoped writes.
//
// `mutate(ctx, key, fn, opts?)` runs the DB write and, on success, emits a
// uniform change event on the bus. Returns a branded `Mutated<T>` — only this
// function constructs the brand, so callers that type their service signatures
// as `Promise<Mutated<T>>` get a compile-time guarantee that the wrapper was
// used. A service that does a raw `db.insert/update/delete` and returns plain
// `T` will fail to type-check at its consumer.
//
// The brand is structural: `as Mutated<T>` casts in production code are
// forbidden by the Reactivity Standard. The only legitimate cast lives in
// `services/__test__/mutate-helpers.ts` (`testMutate()`).

import { bus, type ChangeAction, type ChangeEntity, type ChangeEvent } from "./bus.js";

declare const __mutated: unique symbol;

export type Mutated<T> = T & { readonly [__mutated]: true };

/**
 * Forward an existing brand from one mutate() result onto a sibling value
 * returned by the same orchestrator.
 *
 * Composite orchestrators (e.g. tags.applyTagString) perform their observable
 * write through a branded helper (setTagOnDoc → Mutated<DocumentTag|null>) but
 * want to return a DIFFERENT value (the resolved Tag). They can't re-mint the
 * brand — only mutate() does that — and a second mutate() call would double-emit.
 * `forwardBrand(witness, value)` transfers the brand: the `witness` is proof a
 * mutate() already ran in this call, so re-stamping its sibling `value` is sound.
 *
 * This is the ONE sanctioned brand cast outside mutate() itself (and the test
 * helper). It does NOT touch the DB or the bus — it's a type-level transfer only.
 * The `witness` parameter is unused at runtime; requiring it keeps callers honest
 * (you must hold a genuine Mutated<…> to forward a brand).
 */
export function forwardBrand<W, T>(_witness: Mutated<W>, value: T): Mutated<T> {
  return value as Mutated<T>;
}

// Threaded through every mutation so the emitted ChangeEvent can be attributed
// back to the originating request. `requestId` is the original audit seam;
// `clientId` / `channel` were added for Pulse (b-60) so the activity feed can
// group and label writes by the surface that produced them. All optional —
// call sites that don't (yet) supply context still type-check, and the emitted
// event simply omits the unknown fields.
export interface RequestCtx {
  readonly requestId?: string;
  // Opaque originating-client identifier (connection / session id). Mirrors
  // ChangeEvent.clientId; used by the Pulse feed to attribute and de-dupe.
  readonly clientId?: string;
  // Surface the mutation originated from. Mirrors ChangeEvent.channel.
  readonly channel?: "rest_ui" | "mcp" | "in_app_agent" | "server";
}

export interface ChangeKey {
  memexId: string;
  docId?: string;
  // Optional. Set for user-scoped resources so the /api/me/events SSE channel
  // can fan-out per user. See bus.ts ChangeEvent for the per-entity policy.
  userId?: string;
  entity: ChangeEntity;
  action: ChangeAction;
  // spec-179 (ac-5). Optional structured detail forwarded verbatim onto the
  // emitted ChangeEvent (and from there into activity_log.payload). Used by
  // events whose meaning lives in data rather than prose — e.g. the
  // document/status_changed event's `{from, to}`.
  payload?: Record<string, unknown>;
  // spec-179 (ac-5). Optional narrative override. When set it wins over the
  // auto-composed line — for events like status_changed where
  // `composeNarrative` ("status_changed document …") reads worse than a
  // purpose-built sentence ("moved spec-7 draft → specify").
  narrative?: string;
}

export interface MutateOpts {
  /**
   * Suppress the bus emission. Permitted only for non-user-observable
   * mutations (heartbeats, ephemeral state, idempotent re-writes). See the
   * Reactivity Standard for the opt-out criteria.
   */
  silent?: boolean;
}

/**
 * The bus key for an emission. May be supplied as a literal value or as a
 * factory called with the resolved fn() result — the factory form is needed
 * for creates where the new row's id (e.g. `docId`) is only known after the
 * insert returns. An array of keys is accepted for composite mutations that
 * write multiple FK rows (per dec-2: one event per logical change), or for
 * cross-tenant operations like doc-move that emit on multiple memexes.
 */
export type KeyOrFactory<T> = ChangeKey | ((result: T) => ChangeKey);

// Passive observability counters (doc-16 dec-3). Bumped on every successful
// mutate() so the bus observability logger can compute deltas and surface
// divergence between writes and emits (a sign that someone bypassed mutate
// or that the bus dispatch path was monkey-patched). Never reset.
let writeCount = 0;
let silentWriteCount = 0;
let writesFailed = 0;

export interface MutateMetrics {
  writes: number;
  silentWrites: number;
  writesFailed: number;
}

export function getMutateMetrics(): MutateMetrics {
  return { writes: writeCount, silentWrites: silentWriteCount, writesFailed };
}

// Map a (resolved key, fn result) pair to a human one-line activity summary
// for the Pulse feed (b-60). Best-effort and allocation-light: it reads the
// already-resolved ChangeKey plus whatever identifying fields the just-written
// row happens to carry (`handle`, `seq`, `title`, `name`) — it NEVER issues a
// DB lookup, so it can't slow the write path. When no identifier is available
// it degrades to `<action> <entity>` (e.g. `created task`) rather than guessing.
function composeNarrative(resolved: ChangeKey, result: unknown): string {
  const parts: string[] = [resolved.action, resolved.entity];

  const identifier = resourceIdentifier(resolved, result);
  if (identifier) parts.push(identifier);

  const title = resourceTitle(result);
  if (title) parts.push(`"${title}"`);

  // The doc the resource lives under, when distinct from the resource itself —
  // e.g. `updated decision dec-4 on b-56`. Skipped for doc-tree roots where the
  // resource id IS the docId (avoids `... document doc-7 on doc-7`).
  const docHandle = docContextHandle(result);
  if (docHandle && docHandle !== identifier) parts.push(`on ${docHandle}`);

  return parts.join(" ");
}

// Pull the best resource handle/id from the resolved key or the written row.
// Prefers a human handle (`handle`, or `<prefix>-<seq>`) over a raw UUID.
function resourceIdentifier(resolved: ChangeKey, result: unknown): string | undefined {
  const row = asRecord(result);
  if (row) {
    if (typeof row.handle === "string" && row.handle) return row.handle;
    const prefix = HANDLE_PREFIX[resolved.entity];
    if (prefix && typeof row.seq === "number") return `${prefix}${row.seq}`;
  }
  // Fall back to whatever id the key/row carries (UUIDs as a last resort).
  if (resolved.docId) return resolved.docId;
  if (row && typeof row.id === "string" && row.id) return row.id;
  return undefined;
}

function resourceTitle(result: unknown): string | undefined {
  const row = asRecord(result);
  if (!row) return undefined;
  const raw =
    typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : undefined;
  if (!raw) return undefined;
  // Keep the feed line short; the full title lives on the resource itself.
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
}

// For doc-tree children (decision/task/comment/section/...) the parent doc
// handle is useful trailing context, e.g. `... on b-56`. We only surface it
// when the written row exposes a human `docHandle` — never the raw docId UUID,
// which is noise in the feed.
function docContextHandle(result: unknown): string | undefined {
  const row = asRecord(result);
  if (row && typeof row.docHandle === "string" && row.docHandle) return row.docHandle;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

// Per-entity handle prefixes used to render `<prefix><seq>` when a row exposes a
// numeric `seq` but no precomputed `handle` (mirrors the std-1 handle grammar).
const HANDLE_PREFIX: Partial<Record<ChangeEntity, string>> = {
  decision: "dec-",
  task: "t-",
  section: "s-",
  comment: "c-",
  issue: "issue-",
};

export async function mutate<T>(
  ctx: RequestCtx,
  key: KeyOrFactory<T> | KeyOrFactory<T>[],
  fn: () => Promise<T>,
  opts?: MutateOpts,
): Promise<Mutated<T>> {
  // Run the DB write first. If it throws, we MUST NOT emit — listeners
  // (and the React UI through them) would otherwise refetch and see stale
  // state, masking the failure.
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    writesFailed++;
    throw err;
  }
  writeCount++;
  if (opts?.silent) {
    silentWriteCount++;
  } else {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      const resolved = typeof k === "function" ? k(result) : k;
      // Enrich with Pulse (b-60) attribution. The base ChangeKey fields are
      // spread first so the emitted event still carries the exact key shape;
      // narrative/clientId/channel are layered on top. Each is only set when a
      // value is available so callers without context emit no empty keys.
      const event: ChangeEvent = {
        ...resolved,
        narrative: resolved.narrative ?? composeNarrative(resolved, result),
      };
      if (ctx.clientId !== undefined) event.clientId = ctx.clientId;
      if (ctx.channel !== undefined) event.channel = ctx.channel;
      bus.emit(event);
    }
  }
  return result as Mutated<T>;
}
