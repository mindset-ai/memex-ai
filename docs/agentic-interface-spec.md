# Memex Agentic Interface: Document-Aware AI Agent

**Status:** Draft | **Handle:** doc-1 | **Type:** spec | **Updated:** 2026-03-29

---

## 1. Purpose

Technical specification for adding an AI agent to the Memex web interface that is context-aware of the currently open document, its sections, comments, decisions, and tasks. The agent enables agentic-first interactions with documents — editing sections, resolving decisions, managing tasks, and answering questions, all within a chat interface.

The agent integrates with the existing Memex platform:
- **Server:** Hono API on Cloud Run with Drizzle ORM (`packages/server/`) — agent endpoint added here
- **Admin:** React 19 + TailwindCSS three-panel layout (`packages/ui/`) — chat panel replaces right column
- **Database:** PostgreSQL 16 with existing schema for documents, sections, decisions, tasks, comments
- **LLM:** Direct Anthropic API via `@anthropic-ai/sdk` (JS) — no framework layer, full prompt caching control

## 2. Framework Analysis: LangGraph vs Direct API vs Alternatives

### Use Case Characteristics

- **Reactive agent** — responds to user requests in document context, not complex multi-step planning
- **Large static context** — document sections, comments, decisions, tasks (potentially 10-50K tokens)
- **Stable tool definitions** — document manipulation tools that rarely change
- **Cost sensitive** — prompt caching is critical
- **Minimal state transitions** — no complex graph routing needed

### LangGraph

**Strengths:** Graph-based state management, conditional routing, parallel node execution, checkpointing. Proven in production agents with many nodes and complex routing.

**Weaknesses for this use case:**
- Prompt caching support is poor — `AnthropicPromptCachingMiddleware` exists but you cannot control WHERE breakpoints go
- `create_agent` only accepts string system prompts, not structured messages with `cache_control` headers (open issue since Oct 2025, still unresolved)
- Cannot set different TTLs (5m vs 1h) on different context sections
- Cannot use Anthropic's 4-breakpoint strategy
- Tool definitions go through LangChain's abstraction layer — loses access to `cache_control` on individual tools, `input_examples`, `strict` mode
- All the graph routing/checkpointing overhead provides zero value for a reactive agent loop

### Direct Anthropic API

**Strengths:**
- Full prompt caching control — up to 4 breakpoints, per-tool/per-message/per-system-block, mixable 5m and 1h TTLs
- Cache reads cost **0.1x base input price** (90% savings)
- Full tool calling features — `cache_control` per tool, `input_examples`, `strict: true`
- Agent loop is ~20-30 lines of code (while loop on `stop_reason == "tool_use"`)

**Optimal caching strategy for document editor:**
1. Breakpoint 1: tool definitions (stable, 1h TTL)
2. Breakpoint 2: system prompt + document context (changes on document switch, 5m TTL)
3. Breakpoint 3: conversation history (grows each turn, 5m TTL)

### Other Alternatives

| Framework | Tool Calling | Prompt Caching Control | Notes |
|-----------|-------------|----------------------|-------|
| **Vercel AI SDK** | Full support via Zod schemas | Supported via `providerOptions` + `prepareStep` | Good middle ground for TypeScript; less granular than raw API |
| **Pydantic AI** | Clean Pydantic model tools | Boolean toggles only (cache: yes/no) | No positional breakpoints |
| **Claude Agent SDK** | Built-in code tools | Not exposed | Wrong tool — designed for developer tooling agents, not domain-specific |

### Prompt Caching Control Comparison

| Approach | Tool Caching | System Caching | Message Caching | Breakpoints | TTL Control |
|----------|-------------|----------------|-----------------|-------------|-------------|
| **Direct Anthropic API** | Per-tool | Per-block | Per-message | Up to 4 | 5m + 1h, mixable |
| **Vercel AI SDK** | Supported | Supported | Via prepareStep | Limited | ephemeral only |
| **Pydantic AI** | Boolean toggle | Boolean toggle | Not directly | None | 5m or 1h |
| **LangGraph** | Auto (middleware) | Auto (middleware) | Auto (middleware) | No control | Automatic |

### Decision: Direct Anthropic API (dec-1, dec-2)

**No LangGraph.** The use case is a reactive agent with minimal state transitions — LangGraph's graph routing, checkpointing, and parallel node execution add overhead with zero value here. Critically, LangGraph's prompt caching support is poor: no control over breakpoint placement, can't mix TTLs, tool definitions abstracted through LangChain.

**Direct Anthropic API via `@anthropic-ai/sdk` (JavaScript)** provides full prompt caching control — up to 4 breakpoints with mixable 5m/1h TTLs, cache reads at 0.1x cost (90% savings). We accept the Anthropic lock-in trade-off for maximum caching control and cost efficiency.

The existing Memex server already uses TypeScript/Node.js (Hono + Drizzle), so `@anthropic-ai/sdk` integrates naturally without a new runtime.

## 3. Architecture

### Stack

- **Frontend:** React 19 + TailwindCSS (`packages/ui/`) — existing three-panel `AppShell.tsx`, new chat panel component
- **Backend:** Hono API on Cloud Run (`packages/server/`) — new SSE endpoint at `POST /api/agent/chat`
- **LLM:** `@anthropic-ai/sdk` (JavaScript) — direct API, no framework layer (dec-1, dec-2)
- **Auth:** Google OAuth 2.0 — `@react-oauth/google` on frontend, `google-auth-library` on backend (dec-8)
- **Database:** PostgreSQL 16 via Drizzle ORM — existing document schema + new conversation history tables (dec-5)
- **Deployment:** GCP Cloud Run via existing `deploy.sh` pipeline

The agent endpoint lives in the existing Hono server. The server already has the full service layer (documents, sections, decisions, tasks, comments, dependencies) that agent tools call directly — no duplication or internal API needed. Cloud Run supports long-lived SSE connections (up to 3600s timeout).

### Authentication (dec-8)

Google OAuth 2.0 with no Firebase dependency.

**Frontend:**
- `@react-oauth/google` wraps the app in `<GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>`
- Login page shows "Sign in with Google" button via `<GoogleLogin>` component
- On success, receives a Google ID token (JWT) — stored in memory/context (not localStorage for security)
- All API requests include `Authorization: Bearer {idToken}` header
- Token refresh: Google ID tokens expire after ~1 hour; `useGoogleOneTapLogin` or silent re-auth handles renewal

**Backend:**
- `google-auth-library` package verifies ID tokens on each request
- Hono middleware extracts and verifies the token: `const ticket = await client.verifyIdToken({idToken, audience: GOOGLE_CLIENT_ID})`
- Extracts `sub` (unique Google user ID), `email`, and `name` from the token payload
- `sub` is used as the `userId` in conversation history (stable, globally unique, cross-device)
- Auth middleware applied to `/api/agent/*` routes; existing REST/MCP routes remain unauthenticated for now

**GCP Setup:**
- Create OAuth 2.0 Client ID in GCP Console > APIs & Credentials
- Authorized JavaScript origins: `http://localhost:5173` (dev), `https://app.memex.ai` (prod)
- Client ID passed to frontend via `VITE_GOOGLE_CLIENT_ID` env var
- Client ID also set on server via `GOOGLE_CLIENT_ID` env var (for token verification audience check)

### Models (dec-6)

| Model | Use Case | Cost (input/output per MTok) |
|-------|----------|------------------------------|
| **Sonnet 4.6** | Primary chat agent — tool calling, document editing, Q&A | $3 / $15 |
| **Haiku 4.5** | Background tasks — summarization, lightweight processing | $0.80 / $4 |
| **Opus 4.6** | Reserved for future complex reasoning tasks | $15 / $75 |

Model is configured per-request in the Hono route handler — no architectural changes needed to add or switch models.

### Request Flow

```
React Frontend (packages/ui/ — ChatPanel component)
    |  POST /api/agent/chat + Authorization: Bearer {googleIdToken}
    |  -> SSE stream response
    v
Hono Server (packages/server/src/routes/agent.ts)
    |-- Auth middleware: verify Google ID token, extract userId (sub)
    |-- Validates request (docId, message, contextChips)
    |-- Loads conversation history from Postgres via Drizzle (keyed by userId)
    |-- Fetches document state via existing services (getDoc, listDecisions, listTasks, etc.)
    |-- Constructs system prompt with document context + cache_control breakpoints
    |-- Wraps user message with context chip prefix (dec-7)
    |-- Calls Anthropic API with streaming enabled
    |-- Agent loop: tool_use -> classify -> execute or forward -> continue
    |-- Streams text chunks + UI tool events via SSE
    |-- Persists messages to Postgres on completion
    v
Anthropic API (@anthropic-ai/sdk)
    |-- Server tools: update_section, resolve_decision, create_task, add_comment, etc.
    |   (execute via existing service layer -- no duplication)
    |-- UI tools: render_action_buttons, render_choices, render_confirmation
    |-- System prompt with full document context (cached)
    |-- 3-breakpoint prompt caching strategy
```

### Prompt Caching Strategy (dec-2, dec-3)

| Breakpoint | Content | TTL | Rationale |
|-----------|---------|-----|-----------|
| 1 | Tool definitions (server + UI tools) | 1h | Stable across all sessions |
| 2 | System prompt + full document context | 5m | Changes on document switch or mutation |
| 3 | Conversation history | 5m | Grows each turn, cached between tool-use loops |

Full document state (sections with content, decisions with status/resolution, tasks with blockers, comments) is serialized into a structured system message block with `cache_control` (dec-3). Re-sent each turn but cached — only re-processed when the document actually changes. Cache reads cost 0.1x input price = ~90% savings on repeated turns.

### Streaming Protocol (dec-4)

- Hono SSE endpoint streams Anthropic API response directly to frontend
- **Text events:** `{type: "text", content: "..."}` — forwarded as they arrive
- **UI tool events:** `{type: "ui_tool", name: "render_action_buttons", input: {...}}` — rendered as React components in chat
- **Server tool events:** `{type: "tool_status", name: "update_section", status: "executing"}` — shown as muted status text
- **Done event:** `{type: "done"}` — close SSE connection
- Frontend parses MDX component tags progressively — shows skeleton placeholder until self-closing `/>` tag arrives

### Agent Loop

1. Receive `POST /api/agent/chat` with `{docId, message, contextChips, conversationId?}` + `Authorization` header
2. Auth middleware verifies Google ID token, extracts userId (Google `sub`)
3. Load or create conversation in Postgres (per doc, per user — dec-5)
4. Load message history from Postgres (ordered by seq)
5. Fetch current document state via existing services (`getDoc`, `listDecisions`, `listTasks`, `reviewDocComments`)
6. Construct system prompt with serialized document context (breakpoint 2)
7. Wrap user message with context chip prefix: `[Focus: Section 2 -- Framework Analysis | Decision dec-1]\n\n{message}` (dec-7)
8. Call Anthropic API (Sonnet 4.6) with tools, system, messages — streaming mode
9. Stream text chunks to frontend via SSE
10. If `stop_reason === "tool_use"`:
    - **Server tool** -> execute via existing service functions (e.g., `updateSection()`, `resolveDecision()`), append tool result, loop to step 8
    - **UI tool** -> forward to frontend via SSE event, pause agent loop until user responds
11. Persist all messages (user + assistant + tool results) to Postgres
12. Close SSE connection

### Conversation History (dec-5)

New Drizzle tables added to existing schema (`packages/server/src/db/schema.ts`):

**conversations table:**
- id (uuid PK), docId (FK -> documents, cascade), userId (text — Google `sub` claim from OAuth, dec-8), createdAt, updatedAt
- Unique constraint: (docId, userId) — one conversation per document per user

**messages table:**
- id (uuid PK), conversationId (FK -> conversations, cascade), role (text: user|assistant|tool_use|tool_result), content (jsonb — full Anthropic message format), seq (integer), createdAt

History survives page refreshes and sessions. Messages loaded in order for API call reconstruction. First turn of a new session may have cold cache; subsequent turns benefit from prompt caching. Cross-device history works because userId is the Google account, not a browser-local identifier.

## 4. Chat Interface Design

### Placement

The chat interface replaces the current `SectionInspector` (section details + comments) in the **right column** of the existing `AppShell.tsx` three-panel layout. It is contextually tied to the currently open document.

### Three-Panel Layout (AppShell.tsx)

| Panel | Current State | With Agent |
|-------|--------------|------------|
| **Left (w-56)** | `DocOutline` — section navigation | Same + decision/task quick links |
| **Middle (flex-1)** | `SectionCard` list + `DecisionPanel` + `TaskPanel` | Same + inline comment annotations |
| **Right (w-80)** | `SectionInspector` + `CommentTray` | **Agent chat panel** (replaces inspector) |

The right panel currently uses `WorkspaceContext` to swap between section inspector and all-comments views via `setInspector()`. The agent chat panel becomes the primary right-panel content, managed through the same `WorkspaceContext` mechanism.

### Context Selection Mechanism (dec-7)

The agent always has the full document loaded in its system prompt (cached). The user can **focus** the conversation on a specific element. Context chips are transmitted as a structured prefix in the user message — not in the system prompt — so there is zero caching impact.

**Context Chips:**
- Clicking a **section header**, **decision**, or **task** in the document (middle panel) or nav (left panel) places a **context chip** above the chat input
- The chip shows what's selected (e.g., "Section 2: Framework Analysis" or "Decision dec-1: Should we use LangGraph?")
- Chip has an **X** to dismiss — reverts to general document discussion
- Multiple chips supported (e.g., section + decision)
- On send, chips are serialized as a prefix: `[Focus: Section 2 -- Framework Analysis | Decision dec-1]` before the user's message text

**Text Selection:**
- Highlighting text in the middle panel triggers a floating **"Ask about this"** tooltip
- Clicking it pastes the selected text as a quoted block in the chat input and adds a context chip for the containing section

**Hover Chat Icons:**
- Each `SectionCard`, decision card, and task card shows a subtle **chat bubble icon** on hover
- Clicking focuses the chat on that element (adds context chip)
- Low visual noise — only appears on hover (using `group-hover:opacity-100` pattern already in the codebase)

### Comments -> Inline Annotations

The current `CommentTray` component moves **out of the right panel** and **into the section cards** in the middle panel:

- Comments become **annotation markers** on `SectionCard` components (similar to Google Docs comment indicators)
- Clicking a marker expands the comment thread inline within the section card
- The existing `CommentTray` component is adapted for inline use within `SectionCard`
- Comment counts (already computed in `DocDocument.tsx` via `commentCounts` state) drive the annotation marker display

### Chat Window Layout

```
+-----------------------------+
| Focus: Section 2 -- Framew  |  <- Focus bar (when context chip active)
+-----------------------------+
|                             |
|  User message (glass card)  |  <- Message list (scrollable)
|                             |
|  Agent response (plain)     |
|  <DecisionCard id="dec-1"/> |  <- MDX components inline
|                             |
|  [Rewrite] [Add comments]   |  <- UI tool: action buttons
|                             |
+-----------------------------+
| [Section 2] [dec-1]        |  <- Context chips
| Ask about this document...  |  <- Text input
|                        [->] |  <- Send button
+-----------------------------+
```

### Message Styles

Follows existing dark theme (`bg-slate-900` base, `slate-800` panels, `blue-400` accents):

- **User messages:** Glass-effect: `bg-slate-800/30 backdrop-blur border border-slate-700 rounded-lg`
- **Agent messages:** Plain text rendered via `react-markdown` + `remark-gfm` + `rehype-highlight`
- **Tool activity:** Muted inline text: `text-slate-500 text-sm` (e.g., "Updated section 2...")

### Scrolling

- `scroll-behavior: smooth` + `overflow-anchor: auto` for native smooth scrolling
- Auto-scroll to bottom on new messages and during streaming
- Scroll anchoring when user scrolls up to read history (don't force back down)

## 5. Rich Chat UI: Interactive Elements in Chat

### Approach: Hybrid — Markdown Components + UI Tool Calls

The chat is NOT text-only. It renders interactive UI elements inline alongside text. Two mechanisms handle different interaction types:

#### 1. Static References -> MDX-style Markdown Components

For referencing document elements, the agent writes markdown with component-like syntax:

```markdown
Here's the decision you asked about:

<DecisionCard id="dec-1" />

You might also want to review:

<SectionLink id="section-2" />

The related task:

<TaskCard id="task-3" />
```

- Custom `components` prop on `ReactMarkdown` maps these tags to interactive React components
- Components access document state from `DocDocument.tsx` (already loaded — sections, decisions, tasks)
- Clicking a `<DecisionCard>` scrolls the middle panel to that decision
- Works with SSE streaming — tags parsed progressively, skeleton placeholder shown until self-closing `/>` arrives
- **Component library:** `DecisionCard`, `SectionLink`, `TaskCard`, `CommentThread`, `StatusBadge`

#### 2. Interactive Elements -> UI Tool Calls

For cases where the agent needs user input, it uses **UI tools** — tool calls classified by the Hono endpoint and forwarded to the frontend as SSE events instead of being executed server-side.

**Flow:**
1. Agent calls a UI tool (e.g., `render_action_buttons`)
2. Hono endpoint recognizes it as a UI tool -> sends SSE event: `{type: "ui_tool", name: "...", input: {...}, toolCallId: "..."}`
3. Frontend renders the tool call as a React component in the chat
4. User interacts (clicks a button)
5. Frontend sends result back via POST `/api/agent/chat` with `{toolCallId, result}`
6. Server feeds it into the agent loop as a tool result
7. Agent continues with the user's choice

**UI Tool definitions:**
- `render_action_buttons({buttons: [{label, action, variant}]})` — action button group
- `render_choices({question, options: [{label, value, description}]})` — radio/card selection
- `render_confirmation({message, confirmLabel, cancelLabel})` — yes/no confirmation
- `render_progress({steps: [{label, status}]})` — multi-step progress indicator

### Why Hybrid?

| Case | Mechanism | Cost |
|------|-----------|------|
| Reference a decision, section, or task | MDX component in markdown | Zero — no tool call |
| Show status or metadata inline | MDX component in markdown | Zero — no tool call |
| Offer choices / request user input | UI tool call | Tool call + pause/resume |
| Confirm destructive action | UI tool call | Tool call + pause/resume |

Most turns use MDX components only. UI tool calls are reserved for interactive moments.

## 6. Task Graph and Build Order

### Dependency Graph

```
t-12 (GCP OAuth Client ID setup) -- manual, do first
  \-- t-11 (Google OAuth: frontend + backend) -- blocked by t-12
        \-- t-4 (SSE endpoint) -- needs auth middleware from t-11
        \-- t-5 (Chat panel) -- needs auth context for Bearer token

t-1 (DB schema + migration) -- independent
  \-- t-2 (Agent core) -- needs conversations service from t-1
        \-- t-4 (SSE endpoint) -- needs agent service from t-2

t-3 (Tool definitions) -- independent
  \-- t-2 (Agent core) -- needs tool schemas from t-3

t-10 (System prompt) -- independent
  \-- t-2 (Agent core) -- needs prompt text from t-10

t-9 (Inline comments) -- independent, no dependencies

t-7 (MDX components) -- independent
  \-- t-5 (Chat panel) -- needs components for markdown rendering

t-5 (Chat panel) -- needs t-11 (auth context), t-7 (MDX components)
  \-- t-6 (Context chips) -- needs ChatPanel to exist
  \-- t-8 (UI tool rendering) -- needs ChatPanel SSE client
```

### Build Phases

#### Phase 1: Foundation (all independent, can parallelize) — COMPLETE
| Task | Type | Status | Description |
|------|------|--------|-------------|
| t-12 | Manual | COMPLETE | GCP Console: create OAuth 2.0 Client ID, set env vars |
| t-1 | Backend | COMPLETE | Conversation history: Drizzle schema, migration, service |
| t-3 | Backend | COMPLETE | Agent tool definitions: server tools + UI tools |
| t-10 | Backend | COMPLETE | System prompt and agent instructions |

#### Phase 2: Core Backend + Auth (after Phase 1)
| Task | Depends On | Status | Description |
|------|-----------|--------|-------------|
| t-11 | t-12 | READY | Google OAuth: frontend login + backend middleware |
| t-2 | t-1, t-3, t-10 | READY | Agent core: Anthropic SDK, prompt construction, agent loop |
| t-4 | t-2, t-11 | BLOCKED | SSE streaming endpoint: POST /api/agent/chat |

#### Phase 3: Frontend Core (after Phase 2 + independent work)
| Task | Depends On | Status | Description |
|------|-----------|--------|-------------|
| t-9 | none | READY | Inline comment annotations on SectionCard |
| t-7 | none | READY | MDX chat components: DecisionCard, SectionLink, TaskCard |
| t-5 | t-4, t-11, t-7 | BLOCKED | Chat panel: component, message rendering, scrolling |

#### Phase 4: Frontend Rich (after chat panel exists)
| Task | Depends On | Status | Description |
|------|-----------|--------|-------------|
| t-6 | t-5 | BLOCKED | Context chips and document focus mechanism |
| t-8 | t-5, t-4 | BLOCKED | UI tool rendering and interaction flow |

### Critical Path

```
t-12 -> t-11 -> t-4 -> t-5 -> t-6
t-1 -> t-2 -> t-4 (merges here)
t-3 -> t-2 (merges here)
t-10 -> t-2 (merges here)
```

**Critical path: t-12 -> t-11 + (t-1,t-3,t-10) -> t-2 -> t-4 -> t-5 -> t-6/t-8**

---

## Decisions

All 8 decisions resolved.

| # | Question | Resolution |
|---|----------|------------|
| dec-1 | Should we use LangGraph or is it unnecessary overhead? | No LangGraph — reactive agent with minimal state transitions, LangGraph's prompt caching is poor |
| dec-2 | Which framework best supports prompt caching? | Direct Anthropic API via `@anthropic-ai/sdk` (JS) — full caching control, 4 breakpoints, mixable TTLs |
| dec-3 | How should document context be structured for the LLM? | Full document context as structured system message block with `cache_control` (5m TTL) |
| dec-4 | Should the cloud function stream responses or return them as a single payload? | Stream via SSE — required for progressive MDX component rendering |
| dec-5 | Where should conversation history be stored? | PostgreSQL — per doc, per user, survives refreshes, supports prompt caching |
| dec-6 | Which Anthropic model should be used? | Multi-model: Sonnet 4.6 primary ($3/$15), Haiku 4.5 background ($0.80/$4) |
| dec-7 | How should context chips be transmitted to the agent? | Structured prefix in user message (not system prompt) — zero caching impact |
| dec-8 | How should users be identified for per-user conversation history? | Direct Google OAuth 2.0 — `sub` claim as userId, no Firebase dependency |
