// spec-372 — clipboard prompt prose for the Home onboarding "Create your spec" (step 2)
// and the step-1 "Copy a prompt for your agent" button.
//
// These are HUMAN-PASTED prompts: the user copies them into THEIR coding agent
// (Claude Code / Cursor / …). They are NOT consumed by Mindset's own agent, so —
// per the std-23 carve-out and the b-68 prose-location guard's allowlist — they
// belong in a dedicated UI util module (alongside specInitPrompt.ts / genesisPrompt.ts),
// NOT in scaffold-data.ts (which owns Mindset-agent system-prompt / nudge / rubric prose).

// spec-372 change #11 — the four Stage-2 prompts instruct the agent to create AND
// fully flesh out a complete, build-ready spec (scope ACs + surface decisions), not just
// create_doc. Agent variants are MCP step lists; the in-app variants are natural-language
// prompts pasted into Memex's own creator.
export const SAMPLE_PROMPT = `Using the Memex MCP, create and fully flesh out my first spec in my personal Memex from:

  "Orders Dashboard — a small internal dashboard over a sample sales DB
   (à la Northwind): list orders, filter by customer and date, and a
   revenue-by-month chart."

1. Call list_memexes and pick my personal workspace.
2. Call create_doc with the title "Orders Dashboard" and a clear purpose.
3. Add scope acceptance criteria capturing what "done" looks like.
4. Surface the decisions the build hinges on for me to resolve.
5. Leave it fully fleshed out — not just a stub — so all that's left is for me to resolve the decisions and build.

Then tell me the spec handle (spec-N) you created.`;

export const PRD_PROMPT = `Using the Memex MCP, create and fully flesh out my first spec in my personal Memex from my PRD:

1. Read my PRD at ./docs/prd.md locally.
2. Call list_memexes and pick my personal workspace.
3. Call create_doc with a title and a clear purpose drawn from the PRD.
4. Add scope acceptance criteria capturing what "done" looks like.
5. Surface the decisions the build hinges on for me to resolve.
6. Leave it fully fleshed out — not just a stub — so all that's left is for me to resolve the decisions and build.

Then tell me the spec handle (spec-N) you created.`;

export const APP_SAMPLE_PROMPT = `Create and fully flesh out a spec for an Orders Dashboard — a small internal
dashboard over a sample sales DB (à la Northwind): list orders, filter by
customer and date, and a revenue-by-month chart.

Give it a clear purpose, add scope acceptance criteria for what "done" looks
like, and raise the key decisions for me to resolve — so it's fully fleshed
out, not just a stub.`;

export const APP_PRD_PROMPT = `Create and fully flesh out a spec from my PRD at ./docs/prd.md — draw the
title and purpose from it and keep the scope to what the PRD describes.

Add scope acceptance criteria for what "done" looks like, and raise the key
decisions for me to resolve — so it's fully fleshed out, not just a stub.`;

// spec-372 change #13 — the "Copy a prompt for your agent" clipboard payload (Ryan-
// supplied; doc-grounded MCP evaluation prompt). The design's own placeholder is replaced
// by this authoritative text.
export const EXPLORE_PROMPT = `Fetch and read the Memex documentation at https://www.memex.ai/docs.

Memex is a "living specification and verification layer" that connects to
AI coding agents like you over MCP. I'm evaluating whether to install it.

Based only on what's in that documentation:

1. Explain what Memex is and the problem it solves, in plain terms.
2. Explain how the MCP connection works and what you (my coding agent)
   would be able to do once connected.
3. Tell me the exact steps to connect Memex to the specific tool you are
   running in right now.

Keep everything grounded in the documentation — if something isn't covered
there, say so rather than guessing. Then let me ask follow-up questions,
and when I'm ready, walk me through installing it.`;

export const DOCS_HREF = 'https://www.memex.ai/docs#mcp-tools-reference';
