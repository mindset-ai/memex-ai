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

## Back-end outcomes (whitelisted `mutate()` events, dec-8)

- `document.created` — A document (spec / standard / free-doc) was created. The confirmed outcome behind spec.create_clicked.
- `document.status_changed` — A document advanced to a new phase. props.from / props.to carry the phase handles (e.g. draft → specify).
- `conversation_message.created` — A message was added to an in-app agent conversation.
