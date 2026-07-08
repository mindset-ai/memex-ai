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
  {
    name: "home_canvas.step_shown",
    description:
      "A Home Canvas onboarding journey step became the active card (spec-303/305). props.step is the step id (low-cardinality enum). Recorded via POST /api/me/journey-event, not /telemetry.",
    source: "frontend",
  },
  {
    name: "home_canvas.cta_clicked",
    description:
      "A Home Canvas journey step's CTA was clicked. props.step is the step id; props.cta is the CTA discriminator from the v3 onboarding enum (spec-372 dec-6 Layer C): copy_install | copy_create_prompt | copy_explore_prompt | docs_link | connect_target | create_method | starting_point | copy_prompt (plus the pre-existing submit_identity | create_spec | open_specs). Recorded via POST /api/me/journey-event. The click is the INTENT signal; the step's OUTCOME stays its own server-side event (std-35 cl-12).",
    source: "frontend",
  },
  {
    name: "home_canvas.persona_selected",
    description:
      "The user confirmed their persona on the Home onboarding identity step (spec-372 dec-6 Layer C). props.persona is the RESOLVED persona label/enum (e.g. Builder | Designer | Product lead | Full stack generalist | a combo) — never the raw triangle coordinates. props.step is 'identity'. Recorded via POST /api/me/journey-event. Drives the builder/non-builder branch and the identity-step success signal.",
    source: "frontend",
  },
  {
    name: "signup.form_viewed",
    description:
      "A visitor saw the signup form, pre-authentication (the funnel head). Recorded IDENTIFIER-LESS via the anonymous telemetry ingress (POST /api/telemetry) under legitimate interest — no consent, no visitor_id, no session; pure volume (spec-367, reversing spec-254 dec-4). DNT is not honoured; the settings opt-out still applies. The identified seam is account.created.",
    source: "frontend",
  },
  {
    name: "signup.cta_clicked",
    description:
      "A visitor clicked the primary signup CTA on the signup view (funnel step between form_viewed and account.created). Recorded IDENTIFIER-LESS via the anonymous telemetry ingress (POST /api/telemetry) under legitimate interest — no consent, no visitor_id, no session; pure volume (spec-367). DNT not honoured; settings opt-out applies. props.method is the auth method enum.",
    source: "frontend",
  },
  // ── Front-end engagement interactions (track(), spec-336 follow-on) ──────────
  // Pure UI taps the server never sees — board navigation, search, voice, filters.
  // Server OUTCOMES (spec/decision/task created, phase advanced) stay back-end
  // (Recipe B above); these capture only the interaction/intent (std-35 cl-1).
  {
    name: "auth.login_started",
    description:
      "A sign-in attempt was initiated from the login screen. props.method is the auth method enum (google | password | magic_link). Pre-auth, so fired via trackAnonymous() on the visitor_id; completion stays the server-side account/session outcome.",
    source: "frontend",
  },
  {
    name: "spec.card_opened",
    description:
      "A spec card on the board was opened. props.specSeq (the spec's handle ordinal — the 'spec#'), props.phase (phase enum), props.assigned (bool), props.assignedUserId (opaque user UUID — never a name/email).",
    source: "frontend",
  },
  {
    name: "spec.tab_viewed",
    description:
      "A content sub-tab in the spec detail view was selected (which parts of a spec people read). props.tab is the sub-tab enum (narrative | comments | decisions | work | qa-report); props.phase is the phase view it was selected under (specify | build | verify | done).",
    source: "frontend",
  },
  {
    name: "board.phase_drag",
    description:
      "A spec card was dragged to a different phase column on the board (the interaction). props.from / props.to are phase enums. The OUTCOME stays document.status_changed (back-end); this captures the drag intent (std-35 cl-1).",
    source: "frontend",
  },
  {
    name: "board.tag_filter_applied",
    description:
      "The board tag filter selection changed. props.filterCount is the number of active tag filters (count only — never the tag values).",
    source: "frontend",
  },
  {
    name: "search.opened",
    description:
      "The ⌘K command palette was opened. props.trigger is how it was opened (hotkey | button).",
    source: "frontend",
  },
  {
    name: "search.query_submitted",
    description:
      "A query produced results in the command palette. props.queryLength (character count only — never the query text), props.hasResults (bool).",
    source: "frontend",
  },
  {
    name: "search.result_selected",
    description:
      "A result was chosen in the command palette. props.lane (jumpTo | assigned | content), props.resultKind (entity kind enum), props.resultIndex (position).",
    source: "frontend",
  },
  {
    name: "comments.filter_changed",
    description:
      "A comments filter was changed. props.authorFilter / props.statusFilter are the selected filter enums.",
    source: "frontend",
  },
  {
    name: "whatsnew.opened",
    description:
      "The What's New feed was opened. props.unreadCount is the number of unread items at open (count only).",
    source: "frontend",
  },
  {
    name: "workspace.switched",
    description:
      "The user switched the active Memex via the workspace switcher. props.memexId is the target Memex UUID (id only).",
    source: "frontend",
  },
  {
    name: "voice.mic_permission_result",
    description:
      "The browser microphone permission prompt resolved during a voice session attempt. props.result is the outcome enum (granted | denied | dismissed).",
    source: "frontend",
  },
  {
    name: "voice.icon_shown",
    description:
      "The voice entry point was presented to the user (the adoption denominator). Fired once per mount, not per render. props.surface is where it appeared (icon | pill).",
    source: "frontend",
  },
  {
    name: "home.landing_routed",
    description:
      "The app router (RootRedirect) decided a user's first-load landing from a read-only onboarding-state check (spec-421 dec-5). props.destination is where they were sent (home | specs); props.graduated (bool) is whether the onboarding journey was graduated. Lets us measure whether routing graduated users straight to their Specs board lifts engagement. Advisory (never throws into routing).",
    source: "frontend",
  },
  // ── Onboarding welcome video (spec-444) ─────────────────────────────────────
  // The first-run welcome video (WelcomePage). Front-end lifecycle signals fired
  // via useTelemetry().track() from the tenant-scoped /telemetry ingress, so they
  // carry the real actor_user_id and join the activation funnel. Each fires AT
  // MOST ONCE per view (ref-guarded — replay/seek/pause never re-fire). Props are
  // IDs + counts only (std-35 cl-5): a stable video_id plus playback position /
  // duration / percent (all NaN-guarded numbers, never content).
  {
    name: "onboarding.video_started",
    description:
      "The first-run welcome video began playing (WelcomePage, spec-444). Fires at most once per view on the first play/playing event. props.video_id (stable video slug), props.position_seconds, props.duration_seconds, props.percent_watched (0–100, NaN-guarded) — counts only.",
    source: "frontend",
  },
  {
    name: "onboarding.video_completed",
    description:
      "The first-run welcome video reached its end (WelcomePage 'ended', spec-444). Fires at most once per view. props.video_id, props.position_seconds, props.duration_seconds, props.percent_watched (0–100, NaN-guarded) — counts only. The activation-funnel success signal for the video step.",
    source: "frontend",
  },
  {
    name: "onboarding.video_skipped",
    description:
      "The user dismissed/skipped the first-run welcome video BEFORE completion (WelcomePage Get-started / Skip / × close, spec-444). Fires at most once per view and only when the video has not already completed. props.video_id, props.position_seconds, props.duration_seconds, props.percent_watched (0–100, NaN-guarded) — counts only.",
    source: "frontend",
  },
  {
    name: "onboarding.video_call_cta_shown",
    description:
      "The 'book a call' line on the welcome video revealed once the viewer crossed ~85% of the v4 video, or it ended (WelcomePage, spec-460). Fires at most once per view. props.video_id, props.position_seconds, props.duration_seconds, props.percent_watched — counts only.",
    source: "frontend",
  },
  {
    name: "onboarding.video_call_cta_clicked",
    description:
      "The viewer clicked the revealed 'book a 30-minute call' link on the welcome video (WelcomePage, spec-460), opening the /book-a-call alias in a new tab. props.video_id + playback counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.card_shown",
    description:
      "The Getting Started sidebar card became visible for the first time this session (AppShell, spec-460). Fires at most once per session. No content props — counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.app_row_clicked",
    description:
      "The user clicked the 'Get the desktop app' row in the Getting Started card (spec-460), opening the /download page. Counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.call_row_clicked",
    description:
      "The user clicked the 'Book a 30-min call' row in the Getting Started card (spec-460), opening the /book-a-call alias. Counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.call_row_dismissed",
    description:
      "The user dismissed the 'Book a 30-min call' row (× ) in the Getting Started card (spec-460). Counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.card_dismissed",
    description:
      "The user dismissed the whole Getting Started card (card-level ×) (spec-460). Counts only.",
    source: "frontend",
  },
  {
    name: "getting_started.app_row_retired",
    description:
      "The desktop-app row retired itself because the user's MCP is connected (spec-434 milestone observed, spec-460). Fires at most once per session. Counts only.",
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
  {
    name: "ac.created",
    description:
      "An acceptance criterion was created on a Spec. Already on the bus from createAc ({entity:'ac',action:'created'}); whitelisted here so it mirrors into usage_events as the SUCCESS signal for the Home onboarding 'add-ac' step (spec-372 dec-6 Layer B — success rate = ac.created ÷ home_canvas.step_shown{step:add-ac}).",
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
  {
    name: "identity.merged",
    description:
      "The anonymous→identified stitch (spec-324 — the spec-244 retrofit). Emitted at the identify moment (applyVisitorMerge) when a consented visitor_id first BINDS to a user, carrying BOTH the visitor_id and the user id so Mixpanel merges the visitor's pre-identity events into the user (Simplified ID Merge: $device_id + $user_id). memex_id NULL; keyed on the user UUID.",
    source: "backend",
    delivery: "direct",
  },
  {
    name: "skill.used",
    description:
      "A Skill's SKILL.md BODY was fetched via getSkill (spec-300 dec-21) — the intent-to-use signal (a list_skills appearance is NOT a use). Direct emission from the Skills service, not the bus (a read is not a mutate() outcome). memex_id is the resolved Memex. props.skill_id (doc UUID), props.skill_handle (skill-N), props.skill_ref (canonical ref), props.working_spec_ref (the Spec pulled against, when supplied — the inverse-view key), props.channel (mcp | rest_ui | in_app_agent). Powers the hot/cold-skill report and the per-Spec inverse view.",
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
