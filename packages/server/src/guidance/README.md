# `guidance/` — on-demand operating guidance for MCP clients

This directory holds topic-keyed depth that the `get_information` MCP tool serves to clients on demand. Each topic is a single JSON file. Drop one in, the tool picks it up. No registry, no parsing, no code change.

## Why this directory exists (and why you should care)

The MCP `instructions` field has historically been our channel for telling clients (Claude Code, etc.) how to use Memex correctly: phase mechanics, AC emission, decisions-vs-tasks, standards, troubleshooting, etc. We let that string grow to ~16 KB before discovering a silent killer.

**Claude Code truncates the MCP `instructions` field at 2 KB on session-init.** This is officially documented:

> "Claude Code truncates tool descriptions and server instructions at 2KB each. Keep them concise to avoid truncation, and put critical details near the start."
> — [Connect Claude Code to tools via MCP — Anthropic docs](https://code.claude.com/docs/en/mcp), section *Scale with MCP Tool Search → For MCP server authors*.

The same 2 KB cap also applies to **each tool's `description` field**, so this directory's pattern matters even for non-instructions guidance — a too-long tool description will get truncated the same way, with the same silence. Front-load every description, and push depth into a `get_information` topic.

Everything past that cap is dead text. The agent never sees it. There is no error, no warning. The server publishes 16 KB; the agent receives 2 KB. The author of the next 14 KB believes those clauses are operative; they aren't.

We caught it the hard way: an agent working a Spec in `build` had no idea about the AC tagging mechanic because the AC stanza sat past the cap. It only learned the mechanism after we pointed it at the source code directly. Every prior author who added prose past the cap was operating under a false sense of certainty.

**`get_information` is the structural fix.** The session-init prompt now stays small (rules + a pointer to this tool). All depth lives here, pulled on demand. The agent sees the pointer in the surviving prefix, calls the tool, gets exactly the topic it needs. No truncation. No silent dead text.

Our `MEMEX_AGENT_INSTRUCTIONS` regression guard pins the total length to 1,750 bytes — comfortably below the documented 2,048-byte cap, with ~300 bytes of safety margin against any implementation quirks (system-reminder framing overhead, character-vs-byte counting differences, etc.). The guard fires before any commit that pushes the string past 1,750 — see `packages/server/src/__regression__/instructions-truncation.regression.test.ts`.


## Why not skills?

Claude Code's **skills** mechanism is the well-trodden alternative for delivering on-demand guidance to an agent. Each skill is a separate markdown file with frontmatter; the agent sees skill names in its tool catalogue and invokes them by name. Each skill is, in effect, its own callable verb.

We considered skills and chose `get_information` for V0.0.1. The trade-off is real and worth being explicit about so future contributors understand the reasoning rather than re-litigating it.

| Dimension | Skills | `get_information` |
|---|---|---|
| Per-topic visibility | High — each skill is in tool-selection context every turn | Lower — agent must call the index, then fetch |
| Tool-catalogue footprint | Grows with topic count (N entries) | Constant (1 entry, always) |
| Naming surface area | Each skill needs a name + description | One tool name + N internal slugs (slugs are cheap) |
| Adding a topic | Write a skill file, agent sees the new verb | Write a JSON file, agent sees the index entry |
| Cross-client portability | Claude Code only | Any MCP client (it's just an MCP tool) |
| Activation discipline | Skill description nudges the agent toward it | Same nudges possible via tool description + tool responses |

The two reasons we went with `get_information` over skills:

1. **Tool-catalogue hygiene.** Memex's MCP surface already has ~30 tools (decisions, tasks, comments, ACs, ...). Adding another 5-10 skills (one per guidance topic) bloats the catalogue past the point where an agent can hold the full surface in mind. A single tool that fans out to many topics keeps the catalogue stable as guidance grows.

2. **MCP-native, not Claude-Code-native.** The Memex server is consumed by multiple MCP clients (Claude Code today, but Anthropic Connectors and others over time). `get_information` is a plain MCP tool that works the same way on every client. Skills are a Claude Code feature; other clients wouldn't see them.

The cost we pay: agents have to take one extra step (call the index, decide what to read, fetch the body) instead of having each topic announce itself. That cost is offset by activation-moment nudges in tool descriptions and tool responses — when `create_ac` is called in build, its response can say "see `get_information({topic:'ac-emission'})`" — which is the same nudge mechanism a skill would have used.

**This is a hypothesis, not a settled decision.** If we find that agents reliably skip the index call and never pull topics, the right move is to revisit. Test both approaches if/when the question reopens. Specifically:

- Watch the server logs for `get_information` calls during real agent sessions. If they're rare, the discovery channel is weak.
- Compare with the same agent invoked via a skill-based equivalent. If skills get invoked more reliably, we have evidence to switch.

For now: `get_information` is the bet, the README captures why, and the regression test keeps the truncation cap honest.

## How these topics differ from Memex standards

These two concepts can read similarly — both are guidance, both are version-controlled, both are pulled by agents on demand. The distinction matters because they live in different places and answer different questions.

| | `get_information` topics (this directory) | Memex standards (`std-N`) |
|---|---|---|
| **Scope** | Cross-tenant. Apply to every client of the Memex platform. | Per-tenant. Apply only within the Memex they live in. |
| **Answers** | "How does a client engage with the Memex toolset and platform?" | "How do *we* (this team, in this project) build software?" |
| **Authored by** | Memex platform maintainers (this codebase). | The Memex tenant — engineers in that workspace. |
| **Lives in** | Source: `packages/server/src/guidance/*.json`. | Database: `documents` table, `doc_type='standard'`. |
| **Examples** | AC emission mechanic, decisions-vs-tasks heuristic, escalation patterns, rule-override protocol. | "All new endpoints follow std-2 routing", "Tests live in `__tests__/`", "Auth uses the X pattern". |
| **Changes with** | A platform release. | A tenant-side decision + commit + sometimes a `propose_standard_change`. |

Memex standards are **the customer's house rules**: which auth pattern, which test layout, which file structure, which review gates. They're authored inside the tenant and reference the tenant's specific codebases / domain.

`get_information` topics are **the constitution**: the operating rules of Memex itself. How tasks vs decisions get created. How ACs become verified. How to escalate when stuck. These don't change between customers — they're how the platform expects its clients (agents) to behave, regardless of whose work they're doing.

A useful test for which side new content belongs on: would a brand-new customer onboarding to Memex need this guidance just to use the platform correctly? If yes, it's a `get_information` topic. Would the guidance only make sense inside the specific workspace where it was written? It's a standard.

## How a topic file works

One JSON object per file, three string fields, exactly:

```json
{
  "title": "Short human-readable topic name",
  "when_to_read": "Situational hint shown in the topic index (one sentence).",
  "body": "The actual content — markdown-flavoured prose, as long as it needs to be."
}
```

- The filename (minus `.json`) is the slug a caller uses: `get_information({ topic: '<slug>' })`. So `ac-emission.json` → `topic: 'ac-emission'`.
- Slug discipline: `[a-z0-9-]+`, must start with a letter/digit. Anything outside that is silently skipped by the index (defence-in-depth against path traversal).
- The body is a single JSON string. Use `\n` for line breaks. Backticks, code fences, full markdown — all fine; it's just a string.
- No additional fields are read today. Add fields if you want, but they're inert until the service is taught to surface them.

That's the whole schema. If `title`, `when_to_read`, or `body` is missing or non-string, the service throws a loud validation error at request time — bad topics never silently degrade.

## Adding a new topic — checklist for contributors (human or AI)

1. Create `packages/server/src/guidance/<slug>.json` with the three fields.
2. Run the dev server. Call `get_information()` from any MCP client (or via curl against `/mcp` with the dev bearer). The new slug should appear in the index with the right title and `when_to_read`.
3. Call `get_information({ topic: '<slug>' })`. The body should come back intact.
4. If a tool's behaviour benefits from this topic, **nudge the agent toward it from the tool's description or response**. The tool description is in tool-selection context every turn; the response lands at activation moments. Naming the topic from those channels dramatically raises the probability that the agent actually pulls the depth at the right moment.
5. Commit the JSON file alongside any tool-description amendments. One conventional commit covers both.

## What NOT to put in `MEMEX_AGENT_INSTRUCTIONS`

If you're tempted to add a paragraph of guidance to the `instructions` string in `packages/server/src/mcp/tools.ts`: **don't, beyond the load-bearing rules.** Anything that doesn't survive the ~2.6 KB cap is invisible to clients. Either:

- It's a non-negotiable rule that must reach every agent at session start — keep it terse, put it in the rules section.
- Or it's depth — put it here as a guidance topic, and reference the topic from the rules section by name.

The session-init prompt is for: who you are, the non-negotiable rules, and a pointer to `get_information`. That's it. Everything else lives in this directory.

## A note on caching

V0.0.1 reads the directory on every call. Files are small and few; the cost is negligible. If profiles ever show this as a hotspot, add an in-memory cache keyed by filename + mtime — but don't bother until then.

## The regression test that keeps the cap honest

A regression test in the server suite asserts that every load-bearing token (the non-negotiable rules + the `get_information` pointer) appears before the truncation cap in `MEMEX_AGENT_INSTRUCTIONS`. If a future contributor pushes a load-bearing rule past the cap, CI fails before the change can land. The list of guarded tokens is in `packages/server/src/__regression__/instructions-truncation.regression.test.ts` (when added) — extend it whenever you add a new load-bearing rule.

Without that test, the silent-killer problem comes back the moment someone writes "just a few more lines" at the top.
