// Cross-instance change-bus relay (spec-156 W1, dec-1).
//
// The in-process ChangeBus (services/bus.ts) fans out to subscribers on ONE
// Node process. In prod, Cloud Run runs up to 3 instances (deploy.sh
// --max-instances 3, ac-27/dec-3) with no session affinity, so an event
// emitted on instance A never reaches an SSE subscriber pinned to instance B.
// This relay closes that gap using Postgres LISTEN/NOTIFY — zero new
// dependencies, reusing the `postgres` driver the repo already ships
// (db/connection.ts).
//
// Shape of the bridge:
//   • publish(): on every LOCAL bus emit, NOTIFY 'memex_bus' with the event
//     JSON tagged with this process's origin id. Advisory — failures are
//     caught + logged, never propagated (std-8 §6 read-emission posture), so a
//     down NOTIFY channel can't block or fail mutate() (ac-8).
//   • a dedicated, long-lived LISTEN connection (NOT a pooled connection — a
//     LISTEN must own its socket) re-emits foreign events into the local bus,
//     SKIPPING events whose origin tag is our own so a local emit dispatches
//     exactly once (ac-6, ac-7).
//   • the LISTEN connection auto-reconnects with capped backoff; on each
//     re-establish it nudges local subscribers with a synthetic refetch-trigger
//     event (mirroring the SSE reconnect-refetch contract) so gaps during the
//     outage converge (ac-9).
//   • oversize events (JSON > 8000 bytes, the Postgres NOTIFY payload limit)
//     are relayed TRIMMED (narrative/payload dropped) — the trigger still
//     arrives, fidelity is sacrificed, nothing is silently dropped (ac-10).
//   • ALL bus events ride the relay, including read/advisory interactions
//     (viewed/searched/assessed/called) so Pulse (?include=all) sees activity
//     cross-instance (ac-11). Per-stream filtering stays where it always was —
//     on the subscriber's ChangeFilter — so mutation-only streams are unchanged.

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  RELAY_RECONNECT_MARKER,
  isRelayReconnect,
  type BusRelay,
  type ChangeBus,
  type ChangeEvent,
} from "./bus.js";

// Postgres NOTIFY payload hard limit is 8000 bytes. We stay just under it; an
// event whose serialized form exceeds the budget is relayed trimmed (ac-10).
const NOTIFY_PAYLOAD_LIMIT = 8000;
// Leave headroom for the envelope wrapper (origin id + JSON punctuation) so the
// envelope itself never pushes a near-limit event over.
const ENVELOPE_HEADROOM = 256;

export const BUS_CHANNEL = "memex_bus";

// Per-process origin tag. Generated ONCE at module load — never inside the
// publish/listen workflow (dec-1) — so every instance carries a stable identity
// for the lifetime of the process and self-originated NOTIFYs are recognisable.
export const ORIGIN_ID = randomUUID();

// The wire envelope carried in the NOTIFY payload. `o` = origin id, `t` = a
// trimmed-flag (debug only), `e` = the ChangeEvent.
interface RelayEnvelope {
  o: string;
  t?: 1;
  e: ChangeEvent;
}

// Backoff schedule for LISTEN reconnects (ms), capped. Index clamps at the last
// entry so a long outage settles at the cap rather than growing unbounded.
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000] as const;

/**
 * The minimal LISTEN surface the relay needs. Pulled out as an interface so the
 * relay can be driven by the real `postgres` driver in production and by a fake
 * in tests (deterministic kill-and-recover, no reliance on driver internals).
 */
export interface ListenCallbacks {
  /** Fires per LISTEN message. */
  onNotify: (payload: string) => void;
  /**
   * Fires when the underlying connection drops. The relay degrades its status
   * out of "listening" and (for drivers that do NOT self-reconnect, e.g. the
   * test fake) schedules its own capped-backoff reconnect.
   */
  onError: (err: unknown) => void;
  /**
   * Fires when the LISTEN is RE-established after a drop — NOT on the very first
   * connect. This is the observable that owns the post-reconnect nudge (ac-9)
   * and the health re-count, regardless of WHICH party owns reconnection. For
   * the production postgres-js driver, which self-reconnects internally, this is
   * how the relay learns a reconnect happened at all; for the test fake (relay
   * owns reconnection) the relay fires its own equivalent on connect(true).
   */
  onReconnect?: () => void;
}

export interface ListenDriver {
  /**
   * Open a LISTEN on `channel`. Resolves once the LISTEN is established. Must
   * use a dedicated connection, never a pooled one. See {@link ListenCallbacks}
   * for the lifecycle hooks.
   *
   * A driver that owns its own reconnection (postgres-js) re-establishes the
   * LISTEN internally and signals each recovery via `onReconnect` (and the
   * preceding drop via `onError`); a driver that does NOT (the test fake)
   * surfaces the drop via `onError` and lets the relay's backoff loop re-call
   * a fresh `listen()`.
   */
  listen(channel: string, callbacks: ListenCallbacks): Promise<void>;
  /** Tear down the dedicated LISTEN connection. */
  close(): Promise<void>;
  /**
   * Whether the driver re-establishes the LISTEN on its own after a drop
   * (signalling each recovery via `onReconnect`). The production postgres-js
   * driver does (`true`); the test fake does not (`undefined`/`false`), so the
   * relay owns the backoff loop for it. When `true`, the relay degrades its
   * status on `onError` but does NOT schedule its own reconnect — it waits for
   * the driver's `onReconnect` to restore "listening".
   */
  readonly selfReconnects?: boolean;
}

/**
 * The minimal NOTIFY surface the relay needs on the write path. The real
 * implementation rides the existing pooled `postgres` client (a NOTIFY is a
 * fire-and-forget statement — unlike LISTEN it does not need a dedicated
 * connection).
 */
export interface NotifyDriver {
  notify(channel: string, payload: string): Promise<void>;
}

export type RelayStatus = "connecting" | "listening" | "reconnecting" | "stopped";

export interface RelayHealth {
  /** Whether the dedicated LISTEN connection is currently established. */
  listening: boolean;
  status: RelayStatus;
  originId: string;
  /** How many times the LISTEN connection has (re)established since start. */
  connects: number;
  /** How many reconnect attempts have been scheduled since start. */
  reconnects: number;
  /** Foreign events re-emitted into the local bus. */
  received: number;
  /** Self-originated NOTIFYs skipped on receipt (the dedup count). */
  skippedOwn: number;
  /** Oversize events relayed in trimmed form. */
  trimmed: number;
  /** NOTIFY publish failures swallowed on the write path. */
  publishErrors: number;
}

export interface BusRelayOptions {
  bus: ChangeBus;
  listenDriver: ListenDriver;
  notifyDriver: NotifyDriver;
  channel?: string;
  originId?: string;
  /** Override the backoff schedule (tests use a tight one). */
  backoffMs?: readonly number[];
  /** Injectable timer so tests can drive reconnect timing deterministically. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

/**
 * Trim an event down to the relay-essential fields when its serialized form
 * would blow the NOTIFY budget. We keep the routing/identity fields every
 * subscriber filter and SSE fan-out keys on, and drop the heavy free-text
 * payload (narrative/payload). The trigger — "something changed on docId X of
 * memexId Y" — is what converges remote subscribers; full fidelity is the
 * job of the subsequent refetch, not the relay (ac-10).
 */
export function trimEvent(event: ChangeEvent): ChangeEvent {
  const trimmed: ChangeEvent = {
    memexId: event.memexId,
    entity: event.entity,
    action: event.action,
  };
  if (event.docId !== undefined) trimmed.docId = event.docId;
  if (event.userId !== undefined) trimmed.userId = event.userId;
  if (event.clientId !== undefined) trimmed.clientId = event.clientId;
  if (event.channel !== undefined) trimmed.channel = event.channel;
  return trimmed;
}

/**
 * Reduce an event to the smallest envelope that is structurally guaranteed
 * under the NOTIFY budget when even the trimmed form (ac-10) is too big — e.g. a
 * pathological multi-kilobyte docId or clientId. We keep ONLY origin, entity,
 * action and memexId (themselves truncated to a hard ceiling), plus a truncation
 * marker so the receiver knows fidelity was sacrificed. The trigger still
 * arrives; the subsequent refetch restores fidelity. This path can never exceed
 * budget, so nothing is silently rejected at NOTIFY time (finding 4).
 */
const MINIMAL_FIELD_CEILING = 256;
function minimalEvent(event: ChangeEvent): ChangeEvent {
  const cap = (s: string): string => (s.length > MINIMAL_FIELD_CEILING ? s.slice(0, MINIMAL_FIELD_CEILING) : s);
  return {
    memexId: cap(event.memexId),
    entity: event.entity,
    action: event.action,
    // Reserved marker so a receiver can tell the event was degraded past the
    // ordinary trim — distinct from the relay reconnect nudge marker.
    payload: { __relayTruncated: true },
  };
}

/**
 * Build the NOTIFY payload for an event, trimming if oversize. Exported for the
 * relay and for direct unit testing of the size path (ac-10). Returns the JSON
 * string plus whether trimming was applied.
 *
 * Three tiers, each strictly smaller than the last:
 *   1. full event (the common case);
 *   2. trimmed event — narrative/payload dropped, routing/identity kept (ac-10);
 *   3. minimal event — origin + entity + action + (capped) memexId + a
 *      truncation marker, used only when a pathological identity field (a huge
 *      docId/clientId) leaves even the trimmed form over budget (finding 4).
 * Tier 3 is structurally bounded, so the returned payload is always under
 * budget and never rejected at NOTIFY time.
 */
export function encodeEnvelope(
  originId: string,
  event: ChangeEvent,
  limit = NOTIFY_PAYLOAD_LIMIT,
): { payload: string; trimmed: boolean } {
  const budget = limit - ENVELOPE_HEADROOM;
  const full: RelayEnvelope = { o: originId, e: event };
  const fullJson = JSON.stringify(full);
  if (Buffer.byteLength(fullJson, "utf8") <= budget) {
    return { payload: fullJson, trimmed: false };
  }
  const trimmedEnv: RelayEnvelope = { o: originId, t: 1, e: trimEvent(event) };
  const trimmedJson = JSON.stringify(trimmedEnv);
  if (Buffer.byteLength(trimmedJson, "utf8") <= budget) {
    return { payload: trimmedJson, trimmed: true };
  }
  // Even the trimmed form blew the budget — a pathological identity field.
  // Degrade to the minimal, structurally-bounded envelope.
  // eslint-disable-next-line no-console
  console.error(
    "[bus-relay] trimmed event still over NOTIFY budget — degrading to minimal envelope",
    { entity: event.entity, action: event.action },
  );
  const minimalEnv: RelayEnvelope = { o: originId, t: 1, e: minimalEvent(event) };
  return { payload: JSON.stringify(minimalEnv), trimmed: true };
}

function decodeEnvelope(payload: string): RelayEnvelope | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RelayEnvelope).o === "string" &&
      typeof (parsed as RelayEnvelope).e === "object"
    ) {
      return parsed as RelayEnvelope;
    }
  } catch {
    // Malformed payload — never throw out of the LISTEN handler; a bad message
    // from one publisher must not take down the relay for every other event.
  }
  return null;
}

/**
 * The synthetic refetch-trigger emitted to local subscribers after the LISTEN
 * connection re-establishes (ac-9). It mirrors the SSE reconnect-refetch
 * contract: a no-op-shaped event that carries no specific resource id, so every
 * default-open subscriber refetches and converges gaps that opened during the
 * outage. memexId is empty (a wildcard the SSE layer treats as "refresh").
 */
export function reconnectNudge(): ChangeEvent {
  return {
    memexId: "",
    entity: "memex",
    action: "updated",
    narrative: "bus-relay reconnected — refetch to converge",
    channel: "server",
    // The reserved wildcard marker (services/bus.ts): the bus subscribe filter
    // recognises it and bypasses the memexId/userId/docId identity filters so
    // the nudge reaches EVERY live SSE subscriber (per-memex and per-user),
    // which is the only way the convergence signal lands on real streams.
    payload: { [RELAY_RECONNECT_MARKER]: true },
  };
}

export class PgBusRelay implements BusRelay {
  private readonly bus: ChangeBus;
  private readonly listenDriver: ListenDriver;
  private readonly notifyDriver: NotifyDriver;
  private readonly channel: string;
  private readonly originId: string;
  private readonly backoff: readonly number[];
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  private status: RelayStatus = "stopped";
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private connects = 0;
  private reconnects = 0;
  private received = 0;
  private skippedOwn = 0;
  private trimmed = 0;
  private publishErrors = 0;

  constructor(opts: BusRelayOptions) {
    this.bus = opts.bus;
    this.listenDriver = opts.listenDriver;
    this.notifyDriver = opts.notifyDriver;
    this.channel = opts.channel ?? BUS_CHANNEL;
    this.originId = opts.originId ?? ORIGIN_ID;
    this.backoff = opts.backoffMs ?? BACKOFF_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Write path (std-8 §6 posture): advisory NOTIFY, never throws. */
  publish(event: ChangeEvent): void {
    // Don't echo our own reconnect nudge across the wire — it's a purely-local
    // convergence signal. Cheap structural check, no allocation.
    if (isRelayReconnect(event)) {
      return;
    }
    let payload: string;
    try {
      const encoded = encodeEnvelope(this.originId, event);
      if (encoded.trimmed) this.trimmed++;
      payload = encoded.payload;
    } catch (err) {
      this.publishErrors++;
      // eslint-disable-next-line no-console
      console.error("[bus-relay] failed to encode event for NOTIFY (ignored)", err);
      return;
    }
    // Fire-and-forget. The promise rejection (channel down, pool exhausted) is
    // swallowed — mutate() must complete regardless (ac-8).
    this.notifyDriver.notify(this.channel, payload).catch((err) => {
      this.publishErrors++;
      // eslint-disable-next-line no-console
      console.error("[bus-relay] NOTIFY failed (advisory — ignored)", err);
    });
  }

  /** Open the dedicated LISTEN connection and begin relaying foreign events. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect(false);
  }

  private async connect(isReconnect: boolean): Promise<void> {
    if (this.stopped) return;
    this.status = isReconnect ? "reconnecting" : "connecting";
    try {
      await this.listenDriver.listen(this.channel, {
        onNotify: (payload) => this.onNotify(payload),
        onError: (err) => this.onConnectionError(err),
        // A self-reconnecting driver (postgres-js) re-establishes the LISTEN
        // internally and tells us via this hook — the relay then runs its
        // re-establish path (nudge + health) without driving the backoff loop
        // itself. The fake driver, which does NOT self-reconnect, never calls
        // this; the relay's own backoff loop re-enters connect(true) instead.
        onReconnect: () => this.onReestablished(),
      });
      // Established.
      this.markEstablished(isReconnect);
    } catch (err) {
      // Couldn't establish — treat exactly like a drop and back off.
      this.onConnectionError(err);
    }
  }

  /**
   * Record a (re)established LISTEN: flip to "listening", bump the connect
   * count, reset backoff, and — only on a RE-establish (not the first connect,
   * which has no gap to converge) — nudge local subscribers so events missed
   * during the outage converge (ac-9).
   */
  private markEstablished(isReconnect: boolean): void {
    this.status = "listening";
    this.connects++;
    this.reconnectAttempt = 0;
    if (isReconnect) {
      this.bus.emitRelayed(reconnectNudge());
    }
  }

  /**
   * A self-reconnecting driver (postgres-js) re-established the LISTEN after a
   * drop. postgres-js gives us no separate drop signal on the listen socket —
   * the recovery `onlisten` is the ONLY observable — so we record the reconnect
   * here: count it, restore "listening", and fire the convergence nudge (ac-9).
   * If onError already degraded the status (a driver that DOES surface drops),
   * we don't double-count the reconnect.
   */
  private onReestablished(): void {
    if (this.stopped) return;
    // Count the reconnect only if onError didn't already (status still
    // "listening" means the drop was unobserved — the postgres-js case).
    if (this.status === "listening") this.reconnects++;
    this.markEstablished(true);
  }

  private onConnectionError(err: unknown): void {
    if (this.stopped) return;
    // Degrade status immediately so /api/health reports the outage while it
    // lasts (ac-12, finding 3) — even for a self-reconnecting driver that will
    // restore "listening" via onReconnect a moment later.
    if (this.status === "listening") this.status = "reconnecting";
    // eslint-disable-next-line no-console
    console.error("[bus-relay] LISTEN connection error", err);
    // A self-reconnecting driver (postgres-js) re-establishes the LISTEN itself
    // and signals recovery via onReconnect; the relay must NOT also drive its
    // own backoff loop or the two would race a duplicate LISTEN. The relay's
    // backoff is for drivers that surface a drop and leave re-listen to us.
    if (this.listenDriver.selfReconnects === true) {
      this.reconnects++;
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Coalesce: if a reconnect is already pending, don't stack another.
    if (this.reconnectTimer !== null) return;
    this.status = "reconnecting";
    this.reconnects++;
    const idx = Math.min(this.reconnectAttempt, this.backoff.length - 1);
    const delay = this.backoff[idx]!;
    this.reconnectAttempt++;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.connect(true);
    }, delay);
    // Don't keep the event loop alive on the reconnect timer in production.
    if (typeof (this.reconnectTimer as { unref?: () => void }).unref === "function") {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }

  private onNotify(payload: string): void {
    const env = decodeEnvelope(payload);
    if (env === null) return;
    // Origin dedup (ac-7): our own NOTIFY round-trips back to us because we
    // LISTEN on the same channel we NOTIFY. Skip it — the local emit already
    // dispatched it in-process, re-emitting would double-deliver.
    if (env.o === this.originId) {
      this.skippedOwn++;
      return;
    }
    // Foreign event — re-emit into the LOCAL bus only (emitRelayed does NOT
    // re-publish to the relay, so there's no echo loop). Carries ALL event
    // kinds including reads (ac-11); per-subscriber filters do the rest.
    this.received++;
    this.bus.emitRelayed(env.e);
  }

  /** Stop the relay and tear down the LISTEN connection (tests + shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.status = "stopped";
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.listenDriver.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[bus-relay] error closing LISTEN connection (ignored)", err);
    }
  }

  health(): RelayHealth {
    return {
      listening: this.status === "listening",
      status: this.status,
      originId: this.originId,
      connects: this.connects,
      reconnects: this.reconnects,
      received: this.received,
      skippedOwn: this.skippedOwn,
      trimmed: this.trimmed,
      publishErrors: this.publishErrors,
    };
  }
}

// ── Production drivers (postgres-js) ────────────────────────────────────────
//
// LISTEN owns a dedicated connection (a single-connection postgres client),
// kept entirely separate from the Drizzle pool so a long-lived LISTEN never
// starves the request pool. NOTIFY rides the pooled client passed in — it's a
// fire-and-forget statement and does not need a dedicated socket.

/**
 * Build a ListenDriver backed by its OWN single-connection postgres client
 * (NOT the shared pool). The connection string is taken from DATABASE_URL by
 * default, matching db/connection.ts, with the same Cloud SQL socket handling.
 */
export function createPgListenDriver(opts?: {
  connectionString?: string;
  socketPath?: string;
}): ListenDriver {
  const connectionString = opts?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required for the bus relay LISTEN connection");
  }
  const socketPath = opts?.socketPath ?? process.env.CLOUD_SQL_SOCKET;
  // max:1 — a single dedicated connection for LISTEN, never shared with reads.
  const sql = socketPath
    ? postgres(connectionString, { host: socketPath, max: 1 })
    : postgres(connectionString, { max: 1 });

  return {
    // postgres-js owns reconnection for this driver. Internally, sql.listen()
    // runs LISTEN on its own dedicated single-connection sub-client; when that
    // socket drops, postgres-js's listen-client onclose handler re-establishes
    // EVERY channel and re-invokes our onlisten callback on success (see
    // node_modules/postgres/src/index.js listen()). The relay must NOT also run
    // its own backoff loop, or two LISTENers would race — hence selfReconnects.
    selfReconnects: true,
    async listen(channel, { onNotify, onReconnect }) {
      // postgres-js does NOT expose a per-channel "socket dropped" callback on
      // the internal listen sub-client (its onclose is hardcoded to re-listen),
      // so the only event we can observe is RECOVERY: onlisten fires on the
      // initial connect AND on every internal reconnect. The first call is the
      // initial connect (no gap to converge); each subsequent call means the
      // LISTEN was just re-established after a drop — that is our reconnect
      // signal, which fires the relay's degrade→restore + nudge path (ac-9).
      let established = false;
      await sql.listen(channel, onNotify, () => {
        if (!established) {
          established = true;
          return;
        }
        onReconnect?.();
      });
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Build a NotifyDriver over an existing pooled postgres client. */
export function createPgNotifyDriver(sql: postgres.Sql): NotifyDriver {
  return {
    async notify(channel, payload) {
      await sql.notify(channel, payload);
    },
  };
}

// ── Active-relay registry ───────────────────────────────────────────────────
//
// The boot path (index.ts) constructs the relay and registers it here so the
// health route (app.ts) can read its status without an import cycle on the boot
// module. Single-process / test contexts leave it null — the health route then
// reports `relay: null`, distinct from an attached-but-not-yet-listening relay.

let activeRelay: PgBusRelay | null = null;

/** Register the process-wide relay (called once at boot). */
export function setBusRelay(relay: PgBusRelay | null): void {
  activeRelay = relay;
}

/** Read the process-wide relay for the health surface (ac-12). */
export function getBusRelay(): PgBusRelay | null {
  return activeRelay;
}

// ── Boot wiring ─────────────────────────────────────────────────────────────

/**
 * Construct, attach, register and start the cross-instance bus relay. Called
 * once from index.ts at server boot. The LISTEN side opens its own dedicated
 * single connection; the NOTIFY side rides the shared pooled client passed in.
 *
 * Idempotent: if a relay is already registered, this is a no-op (guards against
 * a double-boot in tests that import index.ts). Returns the relay (or the
 * already-registered one) so the caller can await readiness / inspect health.
 *
 * Failure to establish the initial LISTEN is non-fatal — start() routes it into
 * the capped-backoff reconnect loop, and publish() (the write path) works
 * regardless. The server boots even if Postgres LISTEN is momentarily down.
 */
export async function startBusRelay(deps: {
  bus: ChangeBus;
  pooledSql: postgres.Sql;
}): Promise<PgBusRelay> {
  if (activeRelay) return activeRelay;
  const relay = new PgBusRelay({
    bus: deps.bus,
    listenDriver: createPgListenDriver(),
    notifyDriver: createPgNotifyDriver(deps.pooledSql),
  });
  deps.bus.attachRelay(relay);
  setBusRelay(relay);
  await relay.start();
  return relay;
}
