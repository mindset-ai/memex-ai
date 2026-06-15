// The usage-event registry (spec-244 dec-5) — the single source of truth for
// every product-engagement event the platform may emit.
//
// This is the MACHINE contract: the typed allowlist that BOTH the client (track())
// and the server (the POST /telemetry allowlist + the dec-8 back-end whitelist)
// import. A typo is a compile error against `RegisteredEventName`; an unregistered
// name is rejected server-side. The public event STANDARD (authored once the
// capability is in production, dec-5) is the human contract that mirrors this list;
// a CI parity check (t-7) keeps the two from drifting.
//
// Adding an event is a one-line change here plus either a track() call (front-end)
// or a whitelist tuple (back-end) — the symmetry that lets a future session fill
// funnel gaps without re-plumbing (spec-244 §Design).
//
// RULES for every entry (enforced by description + review, see the Standard):
//   - No PII, no content, no keystrokes. Props carry IDs / enums / counts only.
//   - `source: 'frontend'`  → fired by a client track() call; reaches the server
//                             via POST /telemetry.
//   - `source: 'backend'`   → a whitelisted mutate() outcome ({entity, action});
//                             mirrored into usage_events by the bus subscriber.
//     Back-end names are EXACTLY `${entity}.${action}` so the whitelist mapping
//     is unambiguous (t-3).

export type UsageEventSource = "frontend" | "backend";

export interface UsageEventDef {
  /** Canonical event name, dot-namespaced (e.g. 'spec.create_clicked'). */
  readonly name: string;
  /** Plain-English description of what the event means and when it fires. */
  readonly description: string;
  /** Where the event is born. */
  readonly source: UsageEventSource;
  /**
   * How a back-end event reaches usage_events (ignored for front-end events):
   *  - 'bus' (default) — a whitelisted mutate() ChangeEvent the back-end sink
   *    mirrors. Its name is EXACTLY `${entity}.${action}` so the dec-8 whitelist
   *    maps 1:1, and it carries a real memex_id.
   *  - 'direct' (spec-297 dec-1) — a DIRECT recordUsageEvent() call, NOT on the
   *    bus, for user-scoped funnel events that are not mutations and have no Memex
   *    by nature (account.created, mcp.connected, mcp.tool_called for the
   *    Memex-agnostic tools). These are registered here for the source-of-truth +
   *    Standard parity, but deliberately EXCLUDED from BACKEND_EVENT_NAMES so the
   *    bus whitelist stays precise (a name no mutate() emits would be a dead entry).
   */
  readonly delivery?: "bus" | "direct";
}

// The v1 floor (spec-244 §Design — a floor, not a ceiling). Sharpened during build
// and grown by future sessions against the real value paths.
export const USAGE_EVENT_REGISTRY = [
  // ── Front-end interactions (track()) ────────────────────────────────────────
  {
    name: "spec.create_clicked",
    description: "The 'New spec' CTA was clicked. props.surface names the click site.",
    source: "frontend",
  },
  {
    name: "cta.clicked",
    description: "A tracked primary CTA was clicked. props.id names which CTA.",
    source: "frontend",
  },
  {
    name: "nav.route_changed",
    description:
      "The in-app route template changed. props.route is the route TEMPLATE only — never the query string or concrete ids.",
    source: "frontend",
  },
  {
    name: "speccy.opened",
    description: "The Speccy companion panel was opened.",
    source: "frontend",
  },
  {
    name: "speccy.message_sent",
    description:
      "A message was sent to the Speccy companion. props.wordCount only — never the message text.",
    source: "frontend",
  },
  {
    name: "voice.session_started",
    description: "The voice agent session started.",
    source: "frontend",
  },
  {
    name: "voice.session_ended",
    description: "The voice agent session ended. props.durationMs only.",
    source: "frontend",
  },
  // ── Back-end outcomes (whitelisted mutate() events, dec-8) ───────────────────
  // Name is EXACTLY `${entity}.${action}` so the t-3 whitelist maps 1:1.
  {
    name: "document.created",
    description:
      "A document (spec / standard / free-doc) was created. The confirmed outcome behind spec.create_clicked.",
    source: "backend",
  },
  {
    name: "document.status_changed",
    description:
      "A document advanced to a new phase. props.from / props.to carry the phase handles (e.g. draft → specify).",
    source: "backend",
  },
  {
    name: "conversation_message.created",
    description: "A message was added to an in-app agent conversation.",
    source: "backend",
  },
  {
    name: "task.created",
    description:
      "A task was created on a Spec (funnel stage 7). Already on the bus from the task service ({entity:'task',action:'created'}); whitelisted here so it mirrors into usage_events (spec-297).",
    source: "backend",
  },
  {
    name: "decision.resolved",
    description:
      "A decision was resolved (funnel stage 6). A DISTINCT bus action emitted by resolveDecision alongside the generic 'updated', so the funnel step is unambiguous (spec-297 dec-2).",
    source: "backend",
  },
  // ── Direct-path user-scoped funnel events (spec-297 dec-1) ───────────────────
  // Emitted by a DIRECT recordUsageEvent() call, NOT the bus — they are not
  // mutations and have no Memex by nature, so they carry a NULL memex_id (account
  // / handshake) or the resolved one (tool calls). delivery:'direct' keeps them
  // out of the bus whitelist (BACKEND_EVENT_NAMES) while still source-of-truth.
  {
    name: "account.created",
    description:
      "A new user account was created (funnel stage 1, signup). Direct emission at user-row creation; memex_id is NULL (pre-Memex). Keyed on the new user's UUID.",
    source: "backend",
    delivery: "direct",
  },
  {
    name: "mcp.connected",
    description:
      "An MCP client completed the `initialize` handshake (funnel stage 3, agent connected). Direct emission; memex_id is NULL (no tool has named a Memex yet). Keyed on the acting user's UUID.",
    source: "backend",
    delivery: "direct",
  },
  {
    name: "mcp.tool_called",
    description:
      "An MCP tool was invoked (funnel stage 4). One event per call (not deduped). props.tool_name is the tool name (low-cardinality, non-PII). memex_id is the resolved Memex, NULL only for the Memex-agnostic tools (list_memexes / get_information).",
    source: "backend",
    delivery: "direct",
  },
] as const satisfies readonly UsageEventDef[];

export type RegisteredEventName = (typeof USAGE_EVENT_REGISTRY)[number]["name"];

const BY_NAME: ReadonlyMap<string, UsageEventDef> = new Map(
  USAGE_EVENT_REGISTRY.map((e) => [e.name, e]),
);

/** True iff `name` is a registered event (the server allowlist gate). */
export function isRegisteredEvent(name: string): name is RegisteredEventName {
  return BY_NAME.has(name);
}

/** The definition for a registered event, or undefined. */
export function getUsageEventDef(name: string): UsageEventDef | undefined {
  return BY_NAME.get(name);
}

/** True iff `name` is a registered FRONT-END event (the POST /telemetry gate). */
export function isFrontendEvent(name: string): boolean {
  return BY_NAME.get(name)?.source === "frontend";
}

/**
 * Every registered back-end BUS outcome name (consumed by the t-3 whitelist).
 * Direct-delivery events (spec-297 dec-1) are excluded — they never ride the bus,
 * so whitelisting them would be a dead entry that could only mis-fire.
 */
export const BACKEND_EVENT_NAMES: readonly string[] = USAGE_EVENT_REGISTRY.filter(
  // `as const satisfies` narrows each entry to a literal type that omits the
  // optional `delivery` field, so read it through the interface to access it.
  (e: UsageEventDef) => e.source === "backend" && e.delivery !== "direct",
).map((e) => e.name);

// ── Prop sanitisation (spec-244 §open-source-safe) ──────────────────────────
// Defence-in-depth, shared by client and server so the rule has ONE home: props
// may carry only IDs / enums / counts — never content, keystrokes, or PII. Any
// string longer than an id/enum, or email-shaped, is dropped; nested structures
// are dropped (payloads stay flat). The server re-runs this so a forked client
// that skips the client copy still cannot land content.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_PROP_STRING_LEN = 64;

export function sanitizeUsageProps(
  props?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!props || typeof props !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string") {
      if (v.length > MAX_PROP_STRING_LEN) continue; // free-text / content — drop
      if (EMAIL_RE.test(v)) continue; // email-shaped — drop
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
    // Everything else (objects, arrays, null) is dropped — keep props flat.
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
