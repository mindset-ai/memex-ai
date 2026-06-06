/**
 * Handhold onboarding demo — golden seed fixture (spec-178).
 * ---------------------------------------------------------------------------
 * The five demo Specs are the SAME spec — spec-64, "In-app Memex search (⌘K)" —
 * frozen at five phases. To avoid duplicating ~12k words five times, the canonical
 * content is defined ONCE below, and HANDHOLD_PHASES declares which elements each
 * frozen copy includes (spec-178 ac-2):
 *
 *   draft  → overview only (the raw idea)
 *   specify → overview + narrative sections + decisions (the "why", with rejected options)
 *   build  → + tasks (the agent hand-off)
 *   verify → + tasks complete + acceptance criteria checked (proof it works)
 *   done   → same as verify, closed
 *
 * Content is reproduced VERBATIM from spec-64 (spec-178 ac-2 / dec — language unchanged,
 * differentiation is the DEMO badge, not reworded text).
 *
 * seedHandholdDemo(memexId) maps this into createDocDraft() + add_section / create_decision /
 * create_task / create_ac primitives, then sets documents.is_demo=true and documents.status to
 * each phase. Reset (POST .../handhold/reset) hard-deletes the memex's is_demo docs and re-seeds
 * from this file.
 *
 * TWO JUDGEMENT CALLS — RESOLVED with product (2026-06-05):
 *  1. spec-64's "Rollout / deployment status" section is OMITTED — a real deploy log
 *     (MR numbers, Cloud Run revisions), not demo-relevant feature content. (Confirmed: leave out.)
 *  2. spec-64's cross-references (spec-34 / spec-36 / spec-118 / D-6, …) are KEPT VERBATIM but
 *     must render as PLAIN TEXT, not clickable links (they don't resolve in a fresh personal
 *     Memex). The seed/render path suppresses handle auto-linking for is_demo content
 *     (ac-24: SectionCard skips the rehypeRefLinkifier rehype plugin for is_demo specs).
 *
 * PLAN DECISIONS dec-7 / dec-8 / dec-9 — RESOLVED (2026-06-05):
 *  • dec-7 (backfill): existing personal memexes are backfilled by a one-shot idempotent routine
 *    (reusing seedHandholdDemo under the 0-demo guard) that fires AUTOMATICALLY in the CI/CD
 *    deploy — never run by hand.
 *  • dec-8 (value banner): the `valueCallout` below is served as a per-phase CONSTANT from this
 *    fixture; it is NOT stored per demo document.
 *  • dec-9 (verified ACs): for the verify & done phases, seedHandholdDemo also writes synthetic
 *    PASSING test-event emissions (keyed by each demo AC's ac_uid) so the ACs render 'verified';
 *    Reset must delete those emissions explicitly (test_events has no docId cascade).
 */

export const HANDHOLD_TITLE = "In-app Memex search (⌘K)";

// ---------------------------------------------------------------------------
// Narrative sections (verbatim spec-64). `overview` is the Spec's purpose/Overview.
// ---------------------------------------------------------------------------

export const HANDHOLD_SECTIONS = {
  overview: `The Memex backend can already search — the UI cannot surface it.

\`searchMemex\` (spec-34) runs unified handle + Postgres FTS + pgvector search across Specs, Standards, Documents, Decisions, and Issues, RRF-merged, returning a structured \`MemexSearchHit[]\` — but it is reachable **only** through the \`search_memex\` MCP tool. There is no REST route and no UI; a developer in the React UI cannot run the query an agent runs.

This Spec builds the missing **UI** surface over that existing backend. It reuses the semantic core unchanged and adds only a thin structured lookup for exact navigation:

**Global search via a ⌘K command palette (tiered hybrid, D-6).** A REST route exposes both the structured semantic hits and a fast title / number / assignee lookup as JSON; a ⌘K palette runs them from anywhere in the UI. Results are tiered — exact *Jump to* matches (Spec number, title, assignee) sit above semantic *In content* matches grouped by entity kind (Specs / Standards / Documents / Decisions / Issues), so it's immediately clear which hits are which. Snippets render from structured fields as plain text; the agent-facing markdown never reaches the browser.

Builds on spec-34 (unified search + the per-section embedding pipeline), spec-36 (the search-output URL grammar), and spec-118 (per-Spec assignment).`,

  scope: `Two workstreams. The semantic core (\`searchMemex\`) is reused unchanged; the only new query logic is a thin title / handle / assignee lookup for the *Jump to* tier.

**A. REST search route**
- New \`GET /api/:namespace/:memex/search?q=&kind=&limit=\` returning a combined JSON payload \`{ jumpTo, assigned, content }\` (D-1, D-6). \`content\` is \`searchMemex\`'s \`MemexSearchHit[]\` — kind, canonical path, title, status, RRF score, matching-section snippets, no internal UUIDs — and mirrors the MCP tool's options. \`jumpTo\` is exact handle + title-substring matches over Specs; \`assigned\` is title/handle filtered by assignee via \`doc_assignees\` (spec-118).
- **No status filter — returns what the agent sees** (D-4). The route applies no visibility logic of its own: it inherits \`searchMemex\`'s existing archived/paused exclusion and returns everything else, including \`draft\` documents and decisions/issues on draft parents. This keeps the content tier a pure pass-through over the search core, identical to the MCP/agent surface. (Tradeoff: in-progress drafts are findable by every member with memex access — the same visibility agents already have.)
- The MCP \`search_memex\` markdown formatter stays MCP-only; the REST route is a parallel surface over the same search core.

**B. ⌘K command palette — tiered hybrid (D-6)**
- Global keyboard-triggered overlay (⌘K / Ctrl+K), mounted app-wide, consuming the new REST route.
- Built on the **cmdk** library (D-5) for the accessibility plumbing (focus trap, focus restore, ARIA dialog/listbox semantics, roving arrow-key nav); styled with Tailwind. The ⌘K/Ctrl+K hotkey stays a thin app-level \`keydown\` listener with \`preventDefault\` — cmdk does not own the global shortcut.
- Debounced query input. The query prefix selects the mode: \`spec-N\` → exact handle jump; \`@name\` → assignee filter; free text → title substring + semantic content.
- **Two tiers.** *Jump to* — exact handle / title-substring / assignee matches, rendered as navigation rows with a kind+status badge and no snippet — sits above *In content* — \`searchMemex\` semantic/FTS hits grouped by entity kind (Specs / Standards / Documents / Decisions / Issues), each with one matching-section snippet.
- Snippets render from the structured \`MemexSearchHit\` fields as plain text (markdown stripped); the MCP markdown formatter never reaches the UI.
- Keyboard navigation (arrow keys across tiers, Enter to navigate by canonical \`path\`).
- Optional kind-scope pills mapping to the \`kind\` param; the MVP may ship "All" only.
- No separate /search page or shareable ?q= URLs for the MVP — deferred pending demand (D-2).`,

  approach: `**The semantic backend is complete.** \`searchMemex\` (spec-34) unifies handle + FTS + pgvector via RRF and returns structured \`MemexSearchHit[]\`. The REST route reuses it unchanged for the *In content* tier and adds a thin structured query for the *Jump to* / assignee tier; the palette is a tiered cmdk consumer (D-5, D-6).

**Tiered hybrid surface (D-6).** The palette shows two tiers. *Jump to* answers precise navigation — exact handle (\`spec-N\`), title substring, and assignee (\`@name\`) matches resolved by a thin query over \`documents\` + \`doc_assignees\` (spec-118); these render as badge-tagged navigation rows with no snippet. *In content* answers recall — \`searchMemex\`'s semantic + FTS \`MemexSearchHit[]\`, grouped by entity kind (Specs / Standards / Documents / Decisions / Issues), each with a single matching-section snippet. Snippets are built from the structured \`MemexSearchHit\` fields and rendered as plain text — the MCP markdown formatter (\`formatSearchResults\`) stays MCP-only and never reaches the browser. This keeps the vector→markdown path out of the UI: the browser consumes structured JSON, not agent prose.

**No visibility filter (D-4).** The REST route adds no status logic of its own — it returns the same set as the MCP/agent search: \`searchMemex\` excludes archived/paused content, and everything else comes back, including \`draft\` documents and decisions/issues on draft parents. The palette therefore sees exactly what an agent sees, and the route stays a literal thin pass-through with no new search logic. The tradeoff — in-progress drafts are findable via ⌘K by every member with memex access — is accepted for the MVP (it matches the visibility agents already have).

**Graceful FTS fallback (D-3).** Vector is a recall enhancement — if embeddings aren't backfilled or the provider key is unset, \`searchMemex\` already falls back to FTS-only. Build verification confirms the spec-34 T-2 backfill has run on int + prod; no "semantic unavailable" UI for the MVP.

**Canonical-path navigation.** The palette navigates by \`path\` (e.g. \`/memex-app/specs/spec-34\`), preserving spec-36's no-UUID boundary. Internal UUIDs are dropped from the REST payload or kept only as React keys.`,

  nonGoals: `- **Not** building new *semantic* search logic. The unified handle + FTS + pgvector core (spec-34) is reused unchanged; the only new query is a thin title / handle / assignee lookup for the *Jump to* tier over \`documents\` + \`doc_assignees\`.
- **Not** building a /search page or shareable ?q= URLs for the MVP. The palette is the MVP surface; a dedicated page can be added later over the same REST route if demand surfaces.
- **Not** adding "semantic search unavailable" UI. The FTS fallback is silent and correct; no UI state for the MVP.`,

  architectureSecurity: `**New surface, existing trust boundary.** The only new server surface is \`GET /api/:namespace/:memex/search\`, mounted path-scoped only alongside the other tenant GETs (app.ts). It uses the same read stack as \`routes/documents.ts\` — \`publicSessionMiddleware\` + \`resolveReadableMemexId\` — so visibility matches the platform's existing read model (spec-111): a **public** memex is searchable by anyone (including anonymous); a **private** memex 404s for non-members and anonymous callers; an unknown namespace/memex 404s at \`memexResolver\` before the handler runs (std-7 — unauthorized access returns 404, not 403). Every query is scoped by the resolved \`memex_id\` exactly as \`searchMemex\` already enforces, and the route returns nothing the existing per-entity GETs don't already expose. No new auth path.

**Data exposure.** The route returns structured JSON; internal UUIDs (\`MemexSearchHit.id\` / \`parentDocId\`) are stripped from the payload (or kept only as React keys), preserving spec-36's no-UUID boundary. Per D-4 the surface applies no status filter beyond \`searchMemex\`'s archived/paused exclusion, so \`draft\` content is returned — a deliberate, accepted visibility posture (drafts are already visible to agents and on other surfaces), bounded by the read model above (members only for a private memex; anyone for a public one).

**Assignee join.** The *Jump to* / assignee tier reads \`doc_assignees\` (spec-118), scoped by the same \`memex_id\`; it exposes only assignment facts already rendered on the Specs board. No new PII surface. For anonymous public-read callers the caller-specific assignment lane returns empty rather than a 401, preserving the public-read contract.

**Injection / cost.** Query text flows into Postgres FTS via parameterised \`plainto_tsquery\` (no string-built SQL — no injection surface) and into the embedding provider for the vector arm. Volume is bounded by the client debounce and the \`limit\` cap; the embedding call is the only outbound dependency and already degrades to FTS-only when the key is absent (D-3). The structured tier is a bounded title/handle/assignee lookup over \`documents\` + \`doc_assignees\`.

**Dependencies.** One new client dependency — \`cmdk\` (D-5), a small unstyled UI primitive pinned to a React-19-compatible version. No new server dependency.`,
} as const;

// ---------------------------------------------------------------------------
// Decisions (verbatim spec-64). Seeded as RESOLVED at specify and beyond.
// ---------------------------------------------------------------------------

export const HANDHOLD_DECISIONS = [
  {
    handle: "dec-1",
    title:
      "How does the React UI consume search — a structured-JSON REST route, or the existing MCP markdown?",
    chosen:
      "Chosen: new structured-JSON REST route. Add `GET /api/:namespace/:memex/search?q=&kind=&limit=` that returns structured JSON the UI consumes with no parsing. Per D-6 the payload is a combined `{ jumpTo, assigned, content }`: `content` is `searchMemex`'s `MemexSearchHit[]` (kind / canonical path / title / status / RRF score / matching-section snippets) feeding the semantic *In content* tier; `jumpTo` is exact handle + title-substring matches over Specs; `assigned` is title/handle filtered by assignee via `doc_assignees` (spec-118). The content tier mirrors `searchMemex`'s options. The MCP markdown formatter stays MCP-only. Internal UUIDs are dropped from the payload (or kept only as React keys); the UI navigates by `path`, preserving spec-36's no-UUID boundary, and the route joins the existing path-scoped surface (documents.ts, drift.ts). Rejected: reusing the MCP markdown path — agent-shaped prose with no scores/strategies/UUIDs would force brittle client parsing.",
    context:
      "`searchMemex` (spec-34, services/memex-search.ts) already produces a structured `MemexSearchHit[]` internally — kind, canonical `path`, title, status, RRF score, contributing strategies, and matching-section snippets. The `search_memex` MCP tool then runs that through a formatter that emits canonical-URL markdown with no UUIDs (spec-36). The ⌘K palette needs structured fields it can group by kind and navigate by path; parsing agent-shaped markdown in the client would be brittle and would lose the structured fields.",
  },
  {
    handle: "dec-2",
    title: "What is the search UI surface?",
    chosen:
      "Chosen: ⌘K command palette. A global keyboard-triggered overlay mounted app-wide, debounced query, keyboard navigation, navigate by canonical `path`. Lowest-chrome surface, reachable from anywhere, and mirrors how agents reach search. Per D-6 results are organised in two tiers: an exact *Jump to* tier (handle / title-substring / assignee, navigation rows with a kind+status badge, no snippet) above an *In content* tier of semantic/FTS hits grouped and labelled by entity kind (Specs / Standards / Documents / Decisions / Issues) so it's immediately clear which hits are which. The query prefix selects mode (`spec-N` → jump, `@name` → assignee, free text → title + content). A dedicated /search page and shareable ?q= URLs are deferred — they can be added later over the same REST route and results component if demand surfaces.",
    context:
      "Search must be reachable across the React UI and must make it obvious which hits are Standards vs other content (user requirement). Options differ in invocation cost, discoverability, and how much page chrome they add.",
  },
  {
    handle: "dec-3",
    title:
      "How does the search UI behave when pgvector embeddings aren't backfilled?",
    chosen:
      "Chosen: confirm backfill; graceful FTS fallback, no UI state. Vector is a recall enhancement, not a correctness requirement — `searchMemex` already falls back to FTS-only when embeddings/provider are absent, so search still works lexically. Build carries a verification step: confirm the spec-34 T-2 backfill has run and the embedding provider key is set on int + prod before ship. No \"semantic unavailable\" UI for the MVP — revisit only if the fallback proves confusing in practice.",
    context:
      "Search fuses Postgres FTS and pgvector cosine via RRF. Vector recall depends on backfilled `doc_sections.embedding` rows, produced by spec-34 T-2's fire-and-forget pipeline plus a backfill script. If int/prod aren't backfilled (or the embedding provider key is unset), `searchMemex` silently returns FTS-only results. The UI needs a defined posture.",
  },
  {
    handle: "dec-4",
    title: "Should the in-app search surface return draft documents?",
    chosen:
      "Reversed 2026-06-03 (was: exclude draft documents). The in-app search surface returns the SAME visibility set as the MCP/agent search — it applies no status/visibility filter of its own. `searchMemex`'s existing archived/paused exclusion stays the only visibility gate; `draft` documents (and decisions/issues whose parent is a draft) ARE returned. So the content tier stays a literal pass-through over the search core — no new *visibility* logic — and the palette shows exactly what an agent sees. (The Jump-to tier's title/handle/assignee query, per D-6, is the only new query logic, and it inherits the same no-status-filter posture.) Prior choice (rejected): adding a `draft`-exclusion status filter to the REST surface to mirror list_docs()' ACTIVE-only posture — it diverged the REST surface from the search core and was the only new logic in an otherwise thin mirror. Tradeoff accepted: in-progress drafts become findable via ⌘K by every member with memex access — the same visibility agents already have.",
    context:
      "`searchMemex` (services/memex-search.ts) scopes every query by `memex_id` and excludes only archived/paused content — `AND d.archived_at IS NULL AND d.paused_at IS NULL`. It does NOT filter by `status`, so `draft` documents are returned. But `draft` is the private-authoring phase (std-1; phase guidance: \"private authoring\"), and `list_docs()` already shows ACTIVE Specs only. Without a status filter the ⌘K palette would surface in-progress drafts (e.g. spec-64 itself) to everyone with memex access — contradicting the draft = private intent.",
  },
  {
    handle: "dec-5",
    title: "How is the ⌘K palette built — cmdk library or hand-rolled?",
    chosen:
      "Chosen: build the palette on the cmdk library. A deliberate, scoped exception to the zero-dep bias — that bias targets platform infra (backend deps + SaaS), and a small unstyled UI primitive doesn't carry the same risk. cmdk gives the accessibility plumbing (focus trap, focus restore, ARIA dialog/listbox/combobox, roving arrow-key nav) that a hand-roll would have to reimplement and is easy to get wrong; we keep styling in Tailwind and wire it to the new REST search route. ⌘K/Ctrl+K invocation stays a thin app-level keydown listener with preventDefault (cmdk does not own the global hotkey). Build must pin a cmdk version with React 19 peer support (admin is react ^19.0.0) and verify it mounts cleanly under React 19. Rejected: hand-rolling — saves the dependency but re-implements well-trodden a11y semantics for no real gain here.",
    context:
      "dec-2 settled the surface (⌘K command palette) but not the implementation. The platform's default bias is zero-dep / hand-rolled (no new npm deps for platform infra). A hand-rolled palette is ~40 lines (global keydown + portal overlay), but the fiddly part is accessibility plumbing — focus trap, focus restore on close, ARIA dialog/listbox/combobox semantics, arrow-key roving — which is easy to get subtly wrong. cmdk (pacocoursey, used by shadcn/ui and Vercel) is a small, unstyled React primitive that provides exactly this: keyboard nav, filtering hooks, and the a11y semantics, leaving styling to Tailwind. The admin package is React 19 (packages/admin/package.json: react ^19.0.0); cmdk declares React 18/19 peer support.",
  },
  {
    handle: "dec-6",
    title:
      "What is the MVP search surface — pure semantic search, a structured Spec filter, or a hybrid?",
    chosen:
      "Chosen: C — a tiered HYBRID palette. The ⌘K overlay shows two tiers. **Jump to** (precise navigation): exact handle (`spec-N`), title-substring, and assignee (`@name`) matches resolved by a thin query over `documents` + `doc_assignees` (spec-118) — rendered as navigation rows with a kind+status badge and no snippet. **In content** (recall): `searchMemex`'s semantic + FTS `MemexSearchHit[]`, grouped by entity kind (Specs / Standards / Documents / Decisions / Issues), each with one matching-section snippet. The query prefix selects mode: `spec-N` → jump, `@name` → assignee, free text → title + content. Critically, snippets render from the structured `MemexSearchHit` fields as plain text (markdown stripped); the MCP markdown formatter (`formatSearchResults`) stays MCP-only and never reaches the browser — this keeps the vector→markdown path out of the UI (Barrie's concern). Rejected: A (pure semantic, `kind:'spec'`) — can't do assignee and offers no exact title/number jump; B (pure structured filter) — simplest and reuses the Specs board, but drops the semantic recall that is the whole point of the spec-34 investment. Consequence: extends D-1 (route returns a combined `{ jumpTo, assigned, content }` payload, not bare `MemexSearchHit[]`) and refines D-2 (grouping is tiers-then-kinds, and the kind list now includes Issues). The structured tier is the only new query logic; `searchMemex`'s core is reused unchanged.",
    context:
      "D-2 settled the surface (⌘K palette) and D-1 settled how the UI consumes search (structured-JSON REST over `searchMemex`). A review thread (Barrie/Ryan) surfaced two complications. (1) `searchMemex` does FTS+pgvector over section *content* and structures hits as markdown for the coding agent — so the UI has to think hard about how it renders ranked, snippet-bearing semantic results. (2) Ryan proposed scoping the MVP to Spec Title / Spec Number / Assignee matches to simplify. Grounding both against `origin/develop`: the only \"scope\" param on `searchMemex` is `kind` (entity type) — it does NOT field-scope to title/number/assignee. Spec Number maps to the existing handle short-circuit (`spec-N`); Spec Title is only matched insofar as title words appear in section content; and Assignee is NOT searchable at all — assignment lives in `doc_assignees` (spec-118), which `searchMemex` never joins. So the three options are: A) pure semantic via `searchMemex` scoped to `kind:'spec'`; B) pure structured title/handle/assignee filter; C) hybrid — both, layered in one palette.",
  },
] as const;

// ---------------------------------------------------------------------------
// Tasks (verbatim spec-64). All COMPLETE in source. Visible from build onward.
// `acs` are the task's acceptance-criteria statements; at verify/done they read as checked.
// ---------------------------------------------------------------------------

export const HANDHOLD_TASKS = [
  {
    handle: "t-1",
    title: "REST search route — content tier + combined payload envelope",
    body: "Add `GET /api/:namespace/:memex/search?q=&kind=&limit=` mounted on the tenant prefix in app.ts (alongside docs/drift). It calls `searchMemex` for the `content` tier and returns the combined `{ jumpTo, assigned, content }` envelope (jumpTo/assigned are populated by T-2; this task establishes the route, the envelope, and the content tier). Forward `kind`/`limit` to `searchMemex`; strip internal UUIDs (`id`, `parentDocId`) from `content[]`; apply no status filter of its own (drafts returned; archived/paused excluded by `searchMemex`); unknown namespace/memex → 404 (std-7). When the embedding key is unset, `content` is FTS-only and the route still responds 200. The MCP `formatSearchResults` path is untouched. Delivers ac-6, ac-7, ac-11, ac-13, ac-14.",
    acs: [
      "Route mounted under /api/:namespace/:memex/search; unknown tenant returns 404 (std-7)",
      "Response is { jumpTo, assigned, content }; content[] carries MemexSearchHit fields with no internal UUIDs (ac-6, ac-7)",
      "kind and limit query params are forwarded to searchMemex (ac-7)",
      "Provider key unset → 200 with FTS-only content (ac-11)",
      "Draft docs present in results; archived/paused absent; MCP search_memex unchanged (ac-13, ac-14)",
    ],
  },
  {
    handle: "t-2",
    title: "Structured Jump-to + assignee query (handle / title / assignee)",
    body: "Build the structured tier feeding `jumpTo` and `assigned`: exact handle resolution (spec-N / std-N / doc-N), Spec title-substring match over `documents`, and assignee match over `documents` ⋈ `doc_assignees` (spec-118), all scoped by `memex_id` and honouring the same archived/paused + draft posture as the content tier. Wire the results into the route's `jumpTo` / `assigned` keys (depends on T-1). A `@<name>` query routes to the assignee path. Delivers the data side of ac-17, ac-18, ac-19 and completes ac-6's populated envelope.",
    acs: [
      "Handle query (spec-N) returns the exact entity in jumpTo (ac-17)",
      "Free-text returns Spec title-substring matches in jumpTo alongside searchMemex content (ac-18)",
      "@name returns Specs assigned to that member via doc_assignees in assigned (ac-19)",
      "All arms scoped by memex_id; drafts included; archived/paused excluded — EXCEPT the exact-handle jump arm, which allows paused (user-confirmed 2026-06-03)",
    ],
  },
  {
    handle: "t-3",
    title: "cmdk palette shell + global ⌘K listener",
    body: "Add `cmdk` (pinned to a React-19-compatible version; admin is react ^19.0.0) and build the overlay shell mounted app-wide, consuming the new REST route. A thin app-level `keydown` listener toggles the palette on ⌘K / Ctrl+K with `preventDefault` — cmdk does not own the hotkey. Esc closes and restores focus to the previously focused element. Verify a clean mount under React 19 (no peer/runtime warnings) with role=dialog + listbox/option a11y semantics and aria-selected on the active row. Delivers ac-8, ac-15, ac-16.",
    acs: [
      "cmdk pinned to a React-19-peer version; mounts with no peer/runtime warnings (ac-15)",
      "⌘K / Ctrl+K opens the palette from any route; Esc closes and restores focus (ac-8)",
      "Hotkey is an app-level keydown listener with preventDefault, not cmdk-owned (ac-16)",
      "role=dialog + listbox/option roles with aria-selected on the active row (ac-15)",
    ],
  },
  {
    handle: "t-4",
    title: "Tiered results rendering + keyboard navigation",
    body: "Render the combined payload as two tiers — *Jump to* (badge-tagged navigation rows, no snippet) above *In content* (grouped under kind headers: Specs / Standards / Documents / Decisions / Issues), each with one matching-section snippet built from `MemexSearchHit.matchingSections` rendered as plain text (markdown stripped — never render the `formatSearchResults` output). Single roving arrow-key selection across all tiers and groups; Enter navigates by canonical `path`. Debounced input. FTS-only results render identically with no \"semantic unavailable\" state. Depends on T-1/T-2 for data. Delivers ac-9, ac-10, ac-12, ac-20 and the display side of ac-17/18/19.",
    acs: [
      "Two ordered tiers; In content grouped by kind with kind+status badges (ac-9)",
      "Roving arrow-key selection across tiers/groups; Enter navigates to canonical path (ac-10)",
      "Snippets are plain text from matchingSections; jump rows render no snippet; no markdown rendered in the browser (ac-20)",
      "FTS-only results render with no degraded/unavailable UI (ac-12)",
    ],
  },
  {
    handle: "t-5",
    title: "Confirm pgvector backfill + embedding key on int + prod",
    body: "Deploy-readiness gate for the semantic tier (D-3). Confirm the spec-34 T-2 embedding backfill has run (`doc_sections.embedding` populated for active sections) and the embedding provider key is set on both int and prod, so the *In content* tier returns semantic results in deployed environments. If not backfilled, run `scripts/backfill-memex-embeddings.ts`. No application code change — this is a verification/ops step. Supports ac-11/ac-12 in live envs.",
    acs: [
      "doc_sections.embedding populated for active Spec/Standard/Document sections on int + prod",
      "Embedding provider key set on int + prod",
      "A live query on int returns ≥1 vector-strategy hit — semantic path confirmed live",
    ],
  },
  {
    handle: "t-6",
    title: "Playwright e2e — ⌘K search palette journey",
    body: "Add a Playwright e2e journey proving the palette's real-browser behaviours that the jsdom component tests can't: actual ⌘K/Ctrl+K interception, focus restore to the triggering element on Esc (ac-8), visual tiered rendering + kind badges (ac-9), and arrow-key + Enter navigation to a Spec (ac-10). Follow the existing `packages/admin/e2e/journey-*.spec.ts` conventions (auth/seed/baseURL/webServer in `playwright.config.ts`); new file e.g. `e2e/journey-18-global-search.spec.ts`. Strengthens browser-level verification of ac-8/9/10/16.",
    acs: [
      "New e2e/journey-18-global-search.spec.ts follows existing journey auth/seed/webServer conventions",
      "⌘K opens the palette on a tenant page; Esc closes and focus returns to the previously focused element (real browser — ac-8)",
      "A query renders tiered results with kind badges; ArrowDown + Enter navigates to the hit's page (ac-9/ac-10)",
    ],
  },
  {
    handle: "t-7",
    title:
      "⌘K \"In content\" tier has no relevance floor — low-signal queries return unrelated sections",
    body: "Symptom: a ⌘K query with no strong lexical match (e.g. a personal name) returns a full page of \"In content\" hits — none of which contain the query terms. Root cause: the vector arm has no distance/similarity threshold and the RRF merge has no minimum-score cutoff, so when FTS returns nothing the vector neighbours flow straight through to the limit cap. Fix: add a relevance floor to the semantic tier (max cosine-distance cutoff on the vector arms, or a minimum RRF-score floor) so low-confidence neighbours are dropped rather than displayed. Tune empirically (name queries should collapse to Jump-to + assignee only). (Converted from Issue i-1 [bug, medium].)",
    acs: [
      "A query with no lexical or semantic match returns an empty content[] (not the top-N nearest sections)",
      "A genuinely relevant query is unaffected; covered by an AC-tagged integration test",
    ],
  },
  {
    handle: "t-8",
    title:
      "⌘K palette: make tier/group separators (Assigned / Specs / Standards / Documents) more visually prominent",
    body: "The ⌘K palette groups results under tier/kind headers, but they read as faint, low-contrast uppercase labels inline with the rows, so the boundary between groups is easy to miss. D-6 made \"it's immediately clear which hits are which\" explicit; the current treatment underdelivers. Strengthen the group-header treatment in `SearchPalette.tsx` so each separator is unambiguously a section break (divider rule / higher-contrast header / subtle background band / sticky headers). Keep cmdk's listbox/option semantics intact (group headings stay non-focusable). Purely visual. (Converted from Issue i-2 [todo].)",
    acs: [
      "Group headers render as distinct, unambiguous section separators across multiple tiers",
      "cmdk a11y semantics preserved (group headings non-focusable)",
    ],
  },
  {
    handle: "t-9",
    title:
      "⌘K Decision/Issue hits navigate to a dead deep-link → bounce to the user's personal Memex",
    body: "Symptom: hitting Enter on a Decision or Issue result navigates to the user's personal Memex specs board instead of the hit. Root cause (routing, not search): App.tsx registers `specs/:id` but has no `specs/:id/decisions/:decId` or `specs/:id/issues/:issueId` route, so the deep-link falls to the catch-all RootRedirect. Fix (option B, chosen): add real client routes `specs/:id/decisions/:decId` and `specs/:id/issues/:issueId` rendering the same DocumentShell/DocDocument as `specs/:id`; DocDocument reads the optional sub-param and opens/scrolls to the target. No palette change. (Converted from Issue i-3 [bug, high].)",
    acs: [
      "A decision deep-link renders the Spec document (DocDocument), not a redirect to the default/personal tenant",
      "An issue deep-link behaves the same; the manual ⌘K repro on INT no longer bounces",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Phase composition (spec-178 ac-2). seedHandholdDemo() reads this to decide what each
// frozen copy contains, and sets documents.status to `phase`.
//   - includeSections: which HANDHOLD_SECTIONS keys render (overview is the Spec purpose)
//   - includeDecisions: seed the 6 resolved decisions
//   - includeTasks: seed the 9 tasks
//   - tasksComplete: if true, tasks seed as complete and their ACs read as checked/verified
//                    (verify/done); if false, tasks seed as the not-yet-done plan (build)
//   - includeAcs: acceptance criteria are surfaced/verified (verify/done)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spec-level acceptance criteria (spec-178 t-2 / ac-22). The verify & done frozen
// copies surface the Spec's acceptance criteria as first-class AC rows; this is the
// flat list derived from every task's `.acs` statements (HANDHOLD_TASKS.flatMap).
// All are kind 'implementation' — they're the technical, agent-spawned checks the
// build delivered (the demo has no manager-authored 'scope' ACs). ~23 items.
//
// seedHandholdDemo() creates one AC per entry under the verify/done demo Spec and
// writes a synthetic PASSING test-event emission per AC (dec-9) so each reads
// 'verified'. Reset deletes those emissions (test_events has no docId cascade).
// ---------------------------------------------------------------------------

export const HANDHOLD_ACS: readonly { statement: string; kind: "implementation" }[] =
  HANDHOLD_TASKS.flatMap((t) =>
    t.acs.map((statement) => ({ statement, kind: "implementation" as const })),
  );

export type HandholdPhase = "draft" | "specify" | "build" | "verify" | "done";

export interface HandholdPhaseSlice {
  phase: HandholdPhase;
  includeSections: (keyof typeof HANDHOLD_SECTIONS)[];
  includeDecisions: boolean;
  includeTasks: boolean;
  tasksComplete: boolean;
  includeAcs: boolean;
  /**
   * Per-phase value call-out, rendered as a banner at the TOP of the demo spec, visually
   * DISTINCT from the verbatim spec-64 content (it is demo guidance, not part of the Spec).
   * Names the value Memex adds at this phase. Framing adopted from Barrie's spec-156 writeup;
   * the `done` beat borrows its "stays verified forever" line. (spec-178.)
   */
  valueCallout: string;
}

const ALL_SECTIONS: (keyof typeof HANDHOLD_SECTIONS)[] = [
  "overview",
  "scope",
  "approach",
  "nonGoals",
  "architectureSecurity",
];

export const HANDHOLD_PHASES: HandholdPhaseSlice[] = [
  {
    phase: "draft",
    includeSections: ["overview"],
    includeDecisions: false,
    includeTasks: false,
    tasksComplete: false,
    includeAcs: false,
    valueCallout:
      "**Specify the *why*, in plain language.** The idea is captured as a Spec — the observed problem and the shape of the work — instead of living in a Slack thread or someone's head.",
  },
  {
    phase: "specify",
    includeSections: ALL_SECTIONS,
    includeDecisions: true,
    includeTasks: false,
    tasksComplete: false,
    includeAcs: false,
    valueCallout:
      "**Decisions become first-class — with the roads not taken.** Each real choice (⌘K palette vs. a search page, off-the-shelf vs. hand-rolled, hybrid vs. pure-semantic) is recorded with its reasoning and its rejected alternatives. Nobody re-litigates it in six months.",
  },
  {
    phase: "build",
    includeSections: ALL_SECTIONS,
    includeDecisions: true,
    includeTasks: true,
    tasksComplete: false,
    includeAcs: false,
    valueCallout:
      "**The plan becomes executable work, and tests phone home.** Decisions turn into tasks a coding agent runs; every acceptance criterion is tagged to a test, and the runner reports each pass/fail back to the Spec — so the page shows what's *proven*, live, not claimed.",
  },
  {
    phase: "verify",
    includeSections: ALL_SECTIONS,
    includeDecisions: true,
    includeTasks: true,
    tasksComplete: true,
    includeAcs: true,
    valueCallout:
      "**Confidence against the running system, not the diff.** The criteria are walked against the live app — suite green, the path exercised — and what's proven is visible at a glance.",
  },
  {
    phase: "done",
    includeSections: ALL_SECTIONS,
    includeDecisions: true,
    includeTasks: true,
    tasksComplete: true,
    includeAcs: true,
    valueCallout:
      "**And it stays verified — forever.** Every deploy re-runs the checks against the live environment and re-emits results onto these criteria, so verification is never a point-in-time claim. The full record — spec, decisions, tasks, verified ACs — is permanent; a new joiner gets the whole story instantly.",
  },
];
