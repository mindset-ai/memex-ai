# Memex for Claude — Connector Documentation

> **Draft** — content for the public page that will live at
> [memex.ai/docs/claude](https://memex.ai/docs/claude). Will be published when
> the Privacy Policy + Terms of Service (W7 of spec-31) land. Owned by the
> spec-31 Spec.

Memex.AI is a collaboration platform where humans and AI agents work side-by-
side on **Specs** — living docs of purpose, decisions, and tasks. Connecting
Memex to Claude lets you read, write, and reason about that body of work
directly from the Claude.ai picker, Claude Desktop, or Claude Code.

---

## What you can do

Once connected, Claude can:

- **Read & search** Specs, decisions, tasks, comments, and Standards across
  every Memex you're a member of.
- **Draft** new Specs, add sections, propose decisions for human review.
- **Move work forward** — create tasks, update their status, add blockers,
  resolve decisions when the human confirms.
- **Surface gaps** — flag drift between code and Standards, mark decisions
  as deferred, leave questions for the human when context runs out.

Memex is the system of record. Claude reads from it, writes to it, and
respects the lifecycle phases (`draft → plan → build → verify → done`).

---

## Connect from Claude

### Claude.ai (web — Pro / Team / Enterprise / Claude for Work)

1. Open **Settings → Connectors**.
2. Click **Add custom connector**.
3. Find **Memex.AI** in the directory and click **Connect**.
4. You'll be redirected to sign in to Memex (or create an account if you don't
   have one).
5. Approve the consent screen — "Memex.AI wants full access to your account".
6. You're back in Claude. Memex tools now appear in any conversation.

### Claude Desktop

The same connector also works in Claude Desktop. Add via:

```bash
# Bring Memex up in any conversation
/mcp connect memex
```

Or manually edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://memex.ai/mcp"
    }
  }
}
```

Claude Desktop runs the OAuth flow in your browser the first time it talks
to Memex.

### Claude Code

```bash
claude mcp add memex --transport http https://memex.ai/mcp
```

Claude Code handles the OAuth flow natively (PKCE, refresh-token rotation,
etc.). Re-running `claude mcp add` updates the existing config.

### Manual config (legacy `mxt_` token)

For environments that can't do OAuth — bare scripts, CI runners, etc. — you
can mint a Personal Access Token at `memex.ai/settings/tokens` and use it
directly. **OAuth is preferred** for everything new.

```json
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://memex.ai/mcp",
      "headers": { "Authorization": "Bearer mxt_..." }
    }
  }
}
```

---

## Three example workflows

### 1. "Catch me up on what shipped this week"

Open a Claude conversation, ask:

> What Specs landed in the `mindset/main` Memex this week? Summarise what
> changed.

Claude will call:

- `list_memexes()` — to confirm `mindset/main` is one of yours.
- `list_docs(memex: "mindset/main")` — returns Specs that touched
  `build` / `verify` / `done` status in the last 7 days.
- `get_doc(...)` for the top 2–3, with `verbose: true` to pull narrative
  sections + resolved decisions.

You get back a synthesised summary: "Three Specs advanced this week — the
auth rewrite (spec-12) is in verify, the new Reactivity Standard (std-8)
landed, and the migration smoke test (spec-17) revealed three drift signals
worth tracking."

### 2. "Help me plan this Spec"

You've drafted a one-line idea ("rewrite the onboarding flow") and want
Claude to walk you through scoping it:

> I want to start a new Spec for rewriting the onboarding flow. Help me
> shape it.

Claude will:

1. Confirm which Memex (`list_memexes()`).
2. Ask you a few orienting questions about the *why* — the Spec's Overview.
3. Call `create_doc(...)` to create the Spec in `draft` phase.
4. Walk you through the planning rubric — what decisions need resolving,
   what's out of scope, who else needs to weigh in.
5. As you confirm choices, `create_decision(...)` for each one. Open
   decisions become `update_task(addBlockerRef: "dec-N")` blockers on the
   tasks you'll create later.
6. When you're ready, `update_doc(status: "plan")` to move past the draft
   phase.

The whole flow respects the same rules a human reviewer would: tasks can't
be created until the Spec is in `build`. Claude won't try to skip ahead.

### 3. "Did we already decide this?"

Open Claude inside your IDE, mid-coding:

> Before I change how user sessions expire, has anyone already made a
> decision about this?

Claude will:

- `search_memex(query: "session expiry")` — across decisions, Specs, and
  Standards.
- Surface that `spec-12:dec-3` (resolved) says "30-day sliding window" and that
  `std-2:section 4` reaffirms it.
- Cite both, with URLs, so you can read the original context.

You make an informed choice instead of rediscovering the same decision a
quarter later.

---

## Permissions

When you connect Memex to Claude, you're granting the `memex.full` scope to
**one Org + your personal Memex**. Each OAuth flow grants access to:

- **Your personal Memex** (always).
- **All Memexes within one Org** you choose at the consent screen.

If you're in multiple Orgs and want Claude to read across all of them, run
the connector flow once per Org — each flow produces its own independent
token. Org admins can revoke their Org's tokens without affecting your
other Orgs or your personal Memex.

Within the granted scope, Claude can:

- **Read** every Spec, decision, task, comment, and Standard.
- **Write** to those same surfaces — create Specs, sections, decisions,
  tasks, comments. Update their state. Resolve decisions on your behalf.

Claude **cannot**:

- Access Memexes outside the Org you granted (or any Org you didn't grant).
- Read other users' personal Memexes.
- Change your account settings, password, or org membership.
- Bypass the org-level access controls (per Standard `std-4`).

You can revoke access at any time from
[memex.ai/settings/tokens](https://memex.ai/settings/tokens). Revoking takes
effect immediately — Claude's next call returns 401.

## Why one scope?

Most directory connectors (Slack, Gmail, Drive) offer granular scopes —
`read-channels`, `send-messages`, `delete-files`, and so on. Memex offers
**one scope per Org**, by design. The rationale:

1. **Memex's blast radius is bounded by the Org, not by the verb.** A "read
   decisions" scope and a "write decisions" scope would both ultimately
   touch the same Spec — the only meaningful boundary in Memex is who can
   reach the Org's data, and that's already enforced at the membership
   layer. Granular scopes would be cosmetic.

2. **The Org-scoped grant + per-call membership check is the actual safety
   property.** Every MCP tool call, even at the `memex.full` scope,
   re-validates the user's active membership in the target Org before
   touching data. The OAuth token can't widen access beyond what the
   underlying account already has.

3. **Adding granular scopes is a one-way door.** Once we ship `memex.read`
   + `memex.write` we can't take them back without breaking integrations.
   If real users ask for finer scopes, we'll add them — but starting
   coarse-and-evolving is safer than retrofitting coarseness.

This is a deliberate departure from the directory norm. We're choosing
"Org-scoped grant + tight membership enforcement" over "scope sprawl" as
the safer default for a collaboration platform.

---

## Tool reference

The connector exposes 31 tools. Each carries the standard MCP
`{ readOnlyHint, destructiveHint }` annotations so Claude clients know
when to ask for confirmation.

| Tool | What it does | Annotation |
|---|---|---|
| `list_memexes` | List Memexes you belong to | read-only |
| `list_docs` | List active Specs in a Memex | read-only |
| `get_doc` | Get a Spec with sections / decisions / tasks / comments | read-only |
| `create_doc` | Create a new Spec | write |
| `update_doc` | Rename / move phase / archive | write |
| `add_section` | Add a section to a Spec | write |
| `update_section` | Edit section content | write |
| `create_decision` | Create a decision (open or candidate) | write |
| `update_decision` | Edit title / context / options | write |
| `resolve_decision` | Resolve with a chosen option | write |
| `approve_candidate` / `reject_candidate` | Triage agent-extracted candidates | write |
| `list_tasks` | List tasks (with blocker state) | read-only |
| `create_task` / `update_task` | Manage tasks on a Spec in `build` | write |
| `delete_task` | **Destructive** — Claude asks before calling | **destructive** |
| `add_comment` / `list_comments` / `update_comment` | Threads on sections / decisions / tasks | write / read-only |
| `assess_spec` | Phase-readiness / narrative-freshness / open-comments review | write |
| `publish_spec` | Promote a draft to plan | write |
| `flag_drift` / `propose_standard_change` | Standards drift signals | write |
| `search_standards` | Vector search across Standards | read-only |
| `list_repos` / `get_repo` / `update_repo` | Memex-attached code repos | mixed |
| `list_symbols` / `get_symbol` / `get_file` / `code_search` | Codebase intelligence | read-only |

Full schemas at [github.com/mindset-ai/memex-ai/blob/main/packages/server/src/agent/tool-specs.ts](https://github.com/mindset-ai/memex-ai/blob/main/packages/server/src/agent/tool-specs.ts).

---

## Troubleshooting

**"Memex says 'pick a Memex' but I only have one."**
List_memexes always returns the chooser to prevent silent defaults. Reply
with the namespace/memex slug (e.g. `mindset/main`) and Claude will pin it
for the rest of the conversation.

**Tools time out on large Specs.**
Default tool responses are terse — UUIDs, handles, status, and a snippet.
Pass `verbose: true` on any tool to get the full markdown surface when you
actually need it.

**"Re-run the Memex installer to re-authorize."**
Your token was revoked or rotated. Reconnect via the Claude.ai connector
picker (or `claude mcp add memex --transport http https://memex.ai/mcp`).

**Question or stuck?**
Email [support@memex.ai](mailto:support@memex.ai) with the request ID
shown in the error message. We use it to grep server logs and reply.

---

## Privacy & Terms

By connecting Memex you agree to our
[Privacy Policy](https://memex.ai/privacy) and
[Terms of Service](https://memex.ai/terms).
We do not sell your data, train on your content, or share it with third
parties beyond what's strictly necessary to deliver the service (Anthropic
for the LLM round-trips, Postmark for email).
