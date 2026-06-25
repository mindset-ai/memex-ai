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
// spec-372 issue-11 — the "Use our sample" agent prompt is a rich PRD-style brief
// (problem / users / success / non-goals / constraints / risks) + explicit create_doc and
// per-section instructions, not a terse step list.
export const SAMPLE_PROMPT = `Using the Memex MCP, create and fully flesh out a spec for the following:

Orders Dashboard

Problem: Our ops and sales teams ping engineering 3–5 times a week for ad-hoc data pulls — "show me all orders for Acme Corp in Q1", "what was revenue last month?" Each request takes 24–48 hours and pulls an engineer off real work. We need to eliminate those requests entirely by giving the team a self-service view they can operate without SQL or engineering help.

Users: Four internal people — two ops analysts who check order status daily, one sales manager who filters by customer before calls, and one exec who glances at monthly revenue trends. None of them write SQL. They use this reactively (answer a specific question), not as an always-on dashboard.

What to build: A read-only internal web dashboard over a Northwind-style sample sales DB with three capabilities:
- A paginated, sortable order list (Order ID, customer, date, status, total)
- Customer filter (typeahead) + date-range picker that narrow both the list and the chart simultaneously
- A revenue-by-month bar chart that responds to the active filters

Measurable success: Engineering receives zero ad-hoc CSV export requests within two weeks of the dashboard going live. Any of the four users can answer their own question in under 30 seconds without help.

Explicit non-goals (do not build):
- Order editing or any write operations
- Product-level drill-down or line-item detail view
- CSV / Excel export
- Mobile layout
- Role-based access or per-user permissions

Constraints:
- React + TypeScript preferred (Vite, not Next.js)
- SQLite with a Northwind seed script is fine — no need to scale beyond the sample dataset
- Deploy target: either localhost with a docker compose up or a shared Fly.io URL so the team can bookmark it

Risks to call out:
- Filter query performance if the orders table ever grows beyond the sample size
- Revenue chart misrepresenting partial months at the start/end edges of a date range
- SQLite file not persisting if we later move to a serverless deployment

From this, please:
1. create_doc with a rich purpose narrative that captures the problem, users, and success definition — not just a feature list
2. Add a Problem section, a Non-Goals section, and a Risks section as separate spec sections

Tell me the spec handle when done.`;

// spec-372 issue-12 — the "Point at my PRD" agent prompt is the short 4-step version with a
// fill-in path placeholder (drops the add-ACs / surface-decisions steps).
export const PRD_PROMPT = `Using the Memex MCP, create and fully flesh out my first spec in my personal Memex from my PRD:

1. Read my PRD at <your path to our PRD> locally.
2. Call list_memexes and pick my personal workspace.
3. Call create_doc with a title and a clear purpose drawn from the PRD.
4. Leave it fully fleshed out — not just a stub.

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
