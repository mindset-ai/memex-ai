# Usage-event Standard (spec-244)

The human contract for Memex's product-engagement events. The machine contract is
the in-code registry (`src/usage-events-registry.ts`); this document is its
plain-English mirror. A CI parity check (`src/usage-events-standard.test.ts`) fails
the build if the two drift — every event below must exist in the registry and vice
versa.

> **Status.** This in-repo doc is the working source of truth while the capability
> ships. Per spec-244 dec-5, the public Memex Standard (docType=standard) is authored
> once the capability is in production; it will cite the registry file path and this
> document. Until then, this file is the contract a colleague's Claude Code reads to
> add an event compliantly.

## Rules (every event obeys these)

- **No content, no keystrokes, no PII.** Props carry only IDs, enums, and counts —
  never message text, document content, free text, or email-shaped values. The
  client and server both sanitise props to enforce this.
- **Names are dot-namespaced.** Front-end events read like `area.thing_happened`.
  Back-end outcome names are EXACTLY `${entity}.${action}` so the dec-8 whitelist
  maps one-to-one.
- **Adding an event is one line here + one line in the registry**, plus either a
  `track()` call (front-end) or nothing else (back-end — the mutate() site already
  exists; only the whitelist entry is needed).

## Front-end events (`track()`)

- `spec.create_clicked` — The 'New spec' CTA was clicked. props.surface names the click site.
- `cta.clicked` — A tracked primary CTA was clicked. props.id names which CTA.
- `nav.route_changed` — The in-app route template changed. props.route is the route TEMPLATE only — never the query string or concrete ids.
- `speccy.opened` — The Speccy companion panel was opened.
- `speccy.message_sent` — A message was sent to the Speccy companion. props.wordCount only — never the message text.
- `voice.session_started` — The voice agent session started.
- `voice.session_ended` — The voice agent session ended. props.durationMs only.
- `home_canvas.step_shown` — A Home Canvas onboarding journey step became the active card (spec-303/305). props.step is the step id. Recorded via POST /api/me/journey-event.
- `home_canvas.cta_clicked` — A Home Canvas journey step's CTA was clicked. props.step is the step id; props.cta names the CTA target. The intent signal; the step's outcome stays its own event (std-35 cl-12).
- `home_canvas.persona_selected` — The user confirmed their persona on the Home onboarding identity step (spec-372 dec-6). props.persona is the RESOLVED persona label/enum — never the raw triangle coordinates; props.step is 'identity'. Recorded via POST /api/me/journey-event.
- `signup.form_viewed` — A visitor saw the signup form, pre-auth (the funnel head). Recorded IDENTIFIER-LESS via the anonymous ingress (POST /api/telemetry) under legitimate interest — no consent, no visitor_id; pure volume (spec-367). The identified seam is account.created.
- `signup.cta_clicked` — A visitor clicked the primary signup CTA (between form_viewed and account.created). Recorded IDENTIFIER-LESS via the anonymous ingress under legitimate interest — no consent, no visitor_id; pure volume (spec-367). props.method is the auth method enum.
- `auth.login_started` — A sign-in attempt was initiated. props.method is the auth method enum (google | password | magic_link). Pre-auth → trackAnonymous().
- `spec.card_opened` — A spec card on the board was opened. props.specSeq (the spec's handle ordinal — the "spec#"), props.phase, props.assigned (bool), props.assignedUserId (opaque user UUID — never a name/email).
- `spec.tab_viewed` — A content sub-tab in the spec detail view was selected (which parts people read). props.tab (narrative | comments | decisions | work | qa-report), props.phase (the phase view it was selected under).
- `board.phase_drag` — A spec card was dragged to a different phase column (the interaction; the outcome stays document.status_changed). props.from / props.to are phase enums.
- `board.tag_filter_applied` — The board tag filter changed. props.filterCount is the number of active tag filters (count only).
- `search.opened` — The ⌘K command palette was opened. props.trigger (hotkey | button).
- `search.query_submitted` — A query produced results in the palette. props.queryLength (char count only — never the text), props.hasResults (bool).
- `search.result_selected` — A result was chosen in the palette. props.lane (jumpTo | assigned | content), props.resultKind, props.resultIndex.
- `comments.filter_changed` — A comments filter changed. props.authorFilter / props.statusFilter are the selected filter enums.
- `whatsnew.opened` — The What's New feed was opened. props.unreadCount (count only).
- `workspace.switched` — The active Memex was switched via the workspace switcher. props.memexId (target Memex UUID).
- `voice.mic_permission_result` — The mic permission prompt resolved during a voice attempt. props.result (granted | denied | dismissed).
- `voice.icon_shown` — The voice entry point was presented (adoption denominator). Fired once per mount. props.surface (icon | pill).
- `home.landing_routed` — The app router decided a user's first-load landing from a read-only onboarding-state check (spec-421 dec-5). props.destination (home | specs), props.graduated (bool). Measures whether routing graduated users straight to Specs lifts engagement. Advisory.

## Back-end outcomes (whitelisted `mutate()` events, dec-8)

- `document.created` — A document (spec / standard / free-doc) was created. The confirmed outcome behind spec.create_clicked. For `spec` docs, props.spec_index carries the Nth-spec ordinal for the acting user (spec-297), so depth funnels (2nd, 3rd, Nth spec) come from one event via a property filter.
- `document.status_changed` — A document advanced to a new phase. props.from / props.to carry the phase handles (e.g. draft → specify).
- `conversation_message.created` — A message was added to an in-app agent conversation.
- `task.created` — A task was created on a Spec (funnel stage 7). Already on the bus; whitelisted into usage_events (spec-297).
- `decision.resolved` — A decision was resolved (funnel stage 6). A distinct bus action, separate from the shared `decision.updated`, so the funnel step is unambiguous (spec-297 dec-2).
- `ac.created` — An acceptance criterion was created on a Spec. Already on the bus from createAc; whitelisted into usage_events as the success signal for the Home onboarding 'add-ac' step (spec-372 dec-6 Layer B).

## Direct-path user-scoped funnel events (spec-297 dec-1)

These are emitted by a DIRECT `recordUsageEvent()` call rather than the bus, because
they are not mutations and have no Memex by nature — so they never write an
`activity_log` row, and they carry a NULL `memex_id` (or, for tool calls, the
resolved one). They key on the acting user's UUID (`distinct_id`); `memex_id` is
never forwarded to Mixpanel.

- `account.created` — A new user account was created (funnel stage 1, signup). memex_id NULL (pre-Memex).
- `mcp.connected` — An MCP client completed the `initialize` handshake (funnel stage 3, agent connected). memex_id NULL.
- `mcp.tool_called` — An MCP tool was invoked (funnel stage 4). One event per call. props.tool_name names the tool; memex_id is the resolved Memex, NULL only for the Memex-agnostic tools (list_memexes / get_information).
- `identity.merged` — The anonymous→identified stitch (spec-324, the spec-244 retrofit). Emitted when a consented visitor_id first binds to a user (applyVisitorMerge), carrying both the visitor_id and the user id so Mixpanel merges the visitor's pre-identity events into the user (Simplified ID Merge: $device_id + $user_id). memex_id NULL.
