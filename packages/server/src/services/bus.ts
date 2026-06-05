// Unified in-process change bus.
//
// One emit channel for every tenancy-scoped mutation in the system. Replaces
// (and during transition wraps) the older `doc-events.ts` EventEmitter. The
// SSE endpoints, the React UI's per-doc and per-Memex streams, and every
// future reactive surface subscribe here.
//
// Per the doc-16 audit (§9), the event shape preserves the existing
// `{ memexId, docId?, entity, action }` field names — the §2 architecture
// sketch's `{memex, resourceType, resourceId, op}` maps 1:1 onto those names,
// and renaming would break the per-doc SSE filter and force a 50-callsite
// rewrite for no benefit.

export type ChangeEntity =
  // doc-tree entities — `docId` is required on the event
  | "document"
  | "section"
  | "comment"
  | "decision"
  | "task"
  | "dependency"
  // Wave 2
  | "standard_drift"
  | "conversation_message"
  // spec-136: the tag catalogue (a per-Memex resource; no docId). Changes to a
  // tag *on a Spec* emit `document` updated instead, so the Spec's card refreshes.
  | "tag"
  // feat-ac-spike V0.0.1 — Acceptance Criteria primitive
  | "ac"
  | "ac_parent_link"
  // Issues (spec-112) — bug/todo primitive scoped to a Spec via docId. Writes
  // flow through mutate() with entity:"issue", docId:specId (std-8, ac-11).
  | "issue"
  // spec-150: standard clauses, scoped to a Standard via docId. Writes flow through
  // mutate() with entity:"clause". A clause write also regenerates its section's
  // derived content, so it emits a `section` updated event in the same composite.
  | "clause"
  // Per-Spec roles + assignment (spec-118) — both scoped to a Spec via docId.
  // `doc_member` fires on promote/demote (editor row insert/delete);
  // `doc_assignee` fires on assign/unassign (std-8, ac-20).
  | "doc_member"
  | "doc_assignee"
  // Pulse (b-60) — read/activity entities with no resource target.
  // `query` is a search event (no docId); `tool_call` is the generic MCP
  // invocation fallback when no more specific entity applies.
  | "query"
  | "tool_call"
  // Wave 3 — non-doc tenancy resources; `docId` is undefined for these
  | "org"
  | "org_membership"
  | "org_consent"
  | "org_scaffold_addition"
  | "user_namespace"
  | "memex"
  | "share_token"
  | "mcp_token"
  // Per-Memex AC-emission keys (spec-129). Memex-scoped (memexId set, no docId).
  | "memex_emission_key"
  | "user_slack_token"
  // Per-org Discord webhook URL (spec-138). Org-scoped (memexId="", no docId).
  | "org_discord_webhook"
  | "waitlist_entry"
  // Token-lifecycle + cache entities (silent-allowed per std-8 §6). They flow through
  // mutate({silent:true}) so the wrapper invariant holds even though no SSE
  // consumer subscribes — the brand and the coverage scanner stay structural.
  | "auth_token"
  | "cli_auth_request"
  | "invite_token"
  | "slack_user_cache"
  // OAuth 2.1 token-lifecycle entities (b-31). User/Org-scoped infrastructure
  // with no memexId — silent-allowed per std-8 §6, same as the auth_token group.
  // They flow through mutate({silent:true}) so the Mutated<T> brand and the
  // coverage scanner hold even though no SSE consumer subscribes (spec-156 ac-18).
  | "oauth_client"
  | "oauth_code"
  | "oauth_refresh_token";

export type ChangeAction =
  // Mutation actions — the original bus contract.
  | "created"
  | "updated"
  | "deleted"
  // Pulse (b-60) — read/activity actions. Emitted alongside mutations onto the
  // same bus so the Pulse feed can render reads and writes uniformly.
  | "viewed"
  | "searched"
  | "assessed"
  | "called"
  // spec-179 (ac-5) — emitted alongside the plain "updated" event whenever a
  // Spec's status flips, carrying `payload: {from, to}`. Persisted by the
  // activity-log sink so per-phase durations are exactly computable from
  // transition history (documents.statusChangedAt only keeps the latest).
  | "status_changed";

export interface ChangeEvent {
  memexId: string;
  docId?: string;
  // Optional. Set for user-scoped resources (mcp_tokens, user-side org_consent
  // / org_membership events, namespace ownership) so the per-user SSE channel
  // at /api/me/events can fan-out by user. Memex-scoped entities (document,
  // section, decision, task, comment, dependency) leave this undefined.
  userId?: string;
  entity: ChangeEntity;
  action: ChangeAction;
  // Pulse (b-60). Human-readable one-line summary of the activity. Conceptually
  // required for read actions (viewed/searched/assessed/called) but typed
  // optional so existing mutation emits keep compiling unchanged.
  narrative?: string;
  // Opaque originating-client identifier (e.g. a connection / session id) used
  // to attribute and de-dupe activity in the Pulse feed.
  clientId?: string;
  // Surface the activity originated from.
  channel?: "rest_ui" | "mcp" | "in_app_agent" | "server";
  // Arbitrary structured detail for the activity (e.g. search query text, tool
  // name + args summary). Kept loose on purpose — consumers narrow per entity.
  payload?: Record<string, unknown>;
}

export interface ChangeFilter {
  memexId?: string;
  entity?: ChangeEntity;
  docId?: string;
  userId?: string;
  // Pulse (b-60). Action allowlist. When provided, only events whose `action`
  // is in this set are delivered to the subscriber; all other matching events
  // are filtered out before delivery. When omitted, behaviour is unchanged —
  // every action is delivered (subject to the memexId/entity/docId/userId
  // filters above). This is the mechanism behind the Wave 2 SSE `?include=`
  // param. Default-open by design.
  actions?: readonly ChangeAction[];
}

export type Unsubscribe = () => void;

type Listener = (event: ChangeEvent) => void;

/**
 * Reserved payload marker for the cross-instance relay's reconnect nudge
 * (spec-156 ac-9). After the LISTEN connection re-establishes, the relay emits a
 * synthetic refetch-trigger so subscribers converge gaps opened during the
 * outage. Because the nudge carries no specific resource id, it must reach EVERY
 * live subscriber regardless of their memexId/userId/docId filter — every real
 * SSE stream filters by one of those (routes/doc-events.ts, routes/me.ts), so a
 * filtered nudge would reach nobody. The bus `subscribe` filter recognises this
 * marker and BYPASSES the identity filters (memexId/userId/docId) for it, while
 * still honouring the `actions` allowlist (the nudge's action is "updated", in
 * every mutation-only allowlist, so mutation streams still refetch).
 */
export const RELAY_RECONNECT_MARKER = "__relayReconnect";

/** True if `event` is the relay's wildcard reconnect nudge (spec-156 ac-9). */
export function isRelayReconnect(event: ChangeEvent): boolean {
  return event.payload?.[RELAY_RECONNECT_MARKER] === true;
}

export interface SubscribeOpts {
  /**
   * Permanent subscribers survive `_reset()` and are not counted by the public
   * `_listenerCount()` helper. Reserved for module-load wiring — today only the
   * `doc-events.ts → bus` bridge installed during the t-1/t-2 migration window.
   */
  permanent?: boolean;
}

/**
 * A relay sink the bus forwards LOCALLY-originated emits to (spec-156 W1).
 * The single implementation is the Postgres LISTEN/NOTIFY relay
 * (services/bus-relay.ts), which publishes the event to other server
 * instances. The hook is deliberately narrow — one method — so the bus stays a
 * plain in-process fan-out and the relay is fully optional/injectable: tests
 * that construct or use the bus without a relay behave exactly as before.
 */
export interface BusRelay {
  /** Called for every locally-originated `emit()`. Must never throw. */
  publish(event: ChangeEvent): void;
}

export class ChangeBus {
  private listeners = new Set<Listener>();
  private permanent = new Set<Listener>();

  // Cross-instance relay (spec-156). Optional — undefined means single-process
  // behaviour (the historical default, and the posture under test). Set once at
  // boot via `attachRelay()`.
  private relay: BusRelay | undefined;

  // Passive observability counters (doc-16 dec-3). Incremented on every
  // emit / subscriber error so a periodic logger (services/bus-observability.ts)
  // can compute rolling-window deltas without touching the dispatch path.
  // Never reset in production; the snapshot consumer computes deltas.
  private emits = 0;
  private subscriberErrors = 0;

  /**
   * Install the cross-instance relay (spec-156 W1). Called once at server boot
   * from index.ts. Idempotent-by-overwrite; pass `undefined` to detach (used by
   * tests). Attaching a relay does NOT change local dispatch semantics — it only
   * adds a forward of each locally-originated emit to the relay's publish().
   */
  attachRelay(relay: BusRelay | undefined): void {
    this.relay = relay;
  }

  emit(event: ChangeEvent): void {
    this.dispatch(event);
    // Forward to the cross-instance relay AFTER local dispatch. This is the
    // write-path NOTIFY (std-8 §6 read-emission posture): advisory, and the
    // relay swallows its own failures, so a relay problem can never disturb
    // local delivery or the caller. Only locally-originated emits are
    // forwarded — relayed-in foreign events arrive via emitRelayed() and are
    // never re-published, which is what prevents an inter-instance echo loop.
    if (this.relay !== undefined) {
      try {
        this.relay.publish(event);
      } catch (err) {
        // Belt-and-braces — publish() is contracted not to throw, but the bus
        // must stay alive regardless. eslint-disable-next-line no-console
        console.error("[bus] relay.publish threw (ignored)", err);
      }
    }
  }

  /**
   * Dispatch a foreign event received FROM the relay into local subscribers,
   * without re-forwarding it to the relay (no echo loop) and without counting
   * it as a fresh local emit for relay-forwarding purposes. Used only by the
   * relay's LISTEN handler (spec-156 ac-6/ac-7).
   */
  emitRelayed(event: ChangeEvent): void {
    this.dispatch(event);
  }

  private dispatch(event: ChangeEvent): void {
    this.emits++;
    // Snapshot before iterating so a listener that unsubscribes itself (or
    // another) during dispatch doesn't perturb the iteration order or skip
    // subscribers that were live at emit time.
    const snapshot = [...this.listeners, ...this.permanent];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        this.subscriberErrors++;
        // Subscriber errors must not poison the bus or affect other subscribers.
        // A throwing subscriber is a bug in the subscriber, not the bus.
        // eslint-disable-next-line no-console
        console.error("[bus] subscriber threw during dispatch", err);
      }
    }
  }

  /**
   * Counter snapshot. Used by the periodic observability logger to compute
   * rolling-window deltas against the previous snapshot. Cheap (no allocation
   * beyond the returned object), safe to call from a timer.
   */
  getMetrics(): { emits: number; subscriberErrors: number; listenerCount: number } {
    return {
      emits: this.emits,
      subscriberErrors: this.subscriberErrors,
      listenerCount: this.listeners.size + this.permanent.size,
    };
  }

  subscribe(filter: ChangeFilter, handler: Listener, opts?: SubscribeOpts): Unsubscribe {
    // Precompute the action allowlist as a Set so dispatch is O(1) per event.
    // Undefined (or empty) allowlist means default-open — every action passes.
    const actionAllow =
      filter.actions && filter.actions.length > 0 ? new Set<ChangeAction>(filter.actions) : undefined;
    const listener: Listener = (event) => {
      // The relay reconnect nudge is a wildcard refetch-trigger (spec-156 ac-9):
      // it carries no specific resource id, so it bypasses the identity filters
      // (memexId/userId/docId) and reaches every live subscriber. The `actions`
      // allowlist is still honoured — the nudge's action ("updated") is in every
      // mutation-only allowlist, so mutation-only streams converge too.
      if (isRelayReconnect(event)) {
        if (actionAllow !== undefined && !actionAllow.has(event.action)) return;
        handler(event);
        return;
      }
      if (filter.memexId !== undefined && event.memexId !== filter.memexId) return;
      if (filter.entity !== undefined && event.entity !== filter.entity) return;
      if (filter.docId !== undefined && event.docId !== filter.docId) return;
      if (filter.userId !== undefined && event.userId !== filter.userId) return;
      if (actionAllow !== undefined && !actionAllow.has(event.action)) return;
      handler(event);
    };
    const target = opts?.permanent ? this.permanent : this.listeners;
    target.add(listener);
    return () => {
      target.delete(listener);
    };
  }

  /** @internal test introspection — counts ephemeral listeners only. */
  _listenerCount(): number {
    return this.listeners.size;
  }

  /** @internal test reset; production code must never call this. Permanent subscribers are preserved. */
  _reset(): void {
    this.listeners.clear();
  }

  /** @internal test introspection — whether a cross-instance relay is attached. */
  _hasRelay(): boolean {
    return this.relay !== undefined;
  }
}

export const bus = new ChangeBus();
