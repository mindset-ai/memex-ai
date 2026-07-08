/**
 * spec-473 eval — exercise the in-app agent against live Sonnet 5 with adaptive
 * thinking, to verify the model still reaches for tools reliably (the thinking-on
 * question) and drives each flow end-to-end without truncating or refusing.
 *
 * Covers: creation (buildCreationSystemBlocks + getCreationToolDefinitions) for a
 * rich PRD and a one-liner, and the in-Spec BUILD agent (buildSystemBlocks +
 * getToolDefinitions) asked to create a task and resolve a decision.
 *
 * A MANUAL eval — not part of CI (it's a plain script, makes real paid API calls).
 * Serves the spec-473 Sonnet 5 validation (issue-7). Run all scenarios:
 *   pnpm --filter @memex/server exec tsx scripts/eval-agent-sonnet5.ts
 * or one, by name substring:
 *   pnpm --filter @memex/server exec tsx scripts/eval-agent-sonnet5.ts standards
 * Requires ANTHROPIC_API_KEY (loaded from packages/server/.env below). Tool results
 * are STUBBED so the loop proceeds past render_confirmation / create_doc without a DB.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tsx doesn't auto-load .env — pull ANTHROPIC_API_KEY from packages/server/.env.
try {
  const envText = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* env may be provided externally */
}

const { getAnthropicClient } = await import("../src/agent/anthropic-client.js");
const { buildCreationSystemBlocks, buildSystemBlocks } = await import(
  "../src/agent/system-prompt.js"
);
const { getCreationToolDefinitions, getToolDefinitions } = await import("../src/agent/tools.js");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function stubResult(name: string, input: Record<string, unknown>): string {
  const label = (input.title ?? input.sectionType ?? input.statement ?? input.name ?? "") as string;
  switch (name) {
    case "search_memex":
      return "No closely related Specs were found. The proposed handle is available.";
    case "create_doc":
      return 'Created Spec "spec-eval" (ref: mindset-prod/memex-building-itself/specs/spec-eval). Now populate it with sections, decisions, and acceptance criteria.';
    case "add_section":
      return `Added section "${label || "section"}".`;
    case "create_decision":
      return `Created decision "${label}".`;
    case "create_ac":
      return "Created acceptance criterion.";
    case "create_task":
      return `Created task t-1 "${label}".`;
    case "resolve_decision":
      return "Decision resolved.";
    case "update_section":
      return "Section updated.";
    case "link_ac_to_decision":
      return "Linked AC to decision.";
    case "add_clause":
      return "Clause added to the standard.";
    case "render_confirmation":
      return 'User confirmed: "Yes, go ahead."';
    default:
      return "Done.";
  }
}

async function runScenario(cfg: {
  name: string;
  userText: string;
  system: Any;
  tools: Any;
  maxTurns?: number;
}) {
  const { name, userText, system, tools, maxTurns = 14 } = cfg;
  const client = getAnthropicClient();
  const messages: Any[] = [{ role: "user", content: userText }];

  const toolTotals: Record<string, number> = {};
  let truncated = false;
  let refused = false;
  let thinkingSeen = false;
  const t0 = Date.now();

  console.log(`\n${"=".repeat(78)}\n▶ SCENARIO: ${name}\n${"=".repeat(78)}`);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const stream = client.messages.stream({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system,
      tools,
      messages,
    } as Any);
    const final = (await stream.finalMessage()) as Any;

    const toolBlocks = final.content.filter((b: Any) => b.type === "tool_use");
    const textBlocks = final.content.filter((b: Any) => b.type === "text");
    if (final.content.some((b: Any) => b.type === "thinking" || b.type === "redacted_thinking"))
      thinkingSeen = true;

    for (const b of toolBlocks) toolTotals[b.name] = (toolTotals[b.name] ?? 0) + 1;
    if (final.stop_reason === "max_tokens") truncated = true;
    if (final.stop_reason === "refusal") refused = true;

    const counts = toolBlocks.reduce((acc: Record<string, number>, b: Any) => {
      acc[b.name] = (acc[b.name] ?? 0) + 1;
      return acc;
    }, {});
    const toolSummary =
      Object.entries(counts)
        .map(([n, c]) => ((c as number) > 1 ? `${n}×${c}` : n))
        .join(", ") || "—";
    const snippet = textBlocks
      .map((b: Any) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 90);
    console.log(
      `  turn ${String(turn).padStart(2)} · stop=${String(final.stop_reason).padEnd(10)} · out=${String(
        final.usage?.output_tokens ?? "?",
      ).padStart(4)}tok · tools: ${toolSummary}${snippet ? `\n           text: “${snippet}”` : ""}`,
    );

    if (refused) {
      console.log(`  ⛔ refusal — stop_reason=refusal`);
      break;
    }
    if (toolBlocks.length === 0) break; // end_turn with no tools → done

    // Mirror the production SSE boundary: the server emits `final.content` as JSON
    // in the `message_complete` event, and the client parses it back before
    // replaying it. Round-trip through JSON here so this eval proves thinking
    // blocks (and their `signature`) survive serialization intact — the exact
    // path a thinking-on regression would break. (Verbatim push wouldn't test it.)
    const replayed = JSON.parse(JSON.stringify(final.content));
    if (turn === 1) {
      const th = (final.content as Any[]).find(
        (b) => b.type === "thinking" || b.type === "redacted_thinking",
      );
      if (th)
        console.log(
          `           [thinking block: type=${th.type}, textLen=${(th.thinking ?? "").length}, hasSignature=${Boolean(
            th.signature,
          )}, survivesJSON=${Boolean(replayed.find((b: Any) => b.type === th.type)?.signature) === Boolean(th.signature)}]`,
        );
    }
    messages.push({ role: "assistant", content: replayed });
    messages.push({
      role: "user",
      content: toolBlocks.map((b: Any) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: stubResult(b.name, (b.input ?? {}) as Record<string, unknown>),
      })),
    });
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalsStr =
    Object.entries(toolTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n}×${c}`)
      .join(", ") || "(none)";
  console.log(
    `\n  ── summary (${secs}s) ──\n` +
      `  thinking active : ${thinkingSeen ? "yes ✅" : "NO ⚠️"}\n` +
      `  tools called    : ${totalsStr}\n` +
      `  truncated (max_tokens): ${truncated ? "YES ⚠️" : "no ✅"}\n` +
      `  refused         : ${refused ? "YES ⛔" : "no ✅"}`,
  );
  return { name, toolTotals, truncated, refused, thinkingSeen };
}

const PRD = `Product brief: Saved Views for the reports list

Today users re-apply the same filters (date range, status, owner, tag) every time
they open the reports list. Power users have asked to save a filter combination as
a named "view" they can return to in one click.

Requirements:
- A user can save the current filter set as a named view.
- Saved views appear in a dropdown at the top of the reports list; selecting one
  applies its filters.
- Views are private to the user by default; a user can optionally share a view
  with their whole org.
- A user can rename or delete their own views. Shared views can only be edited by
  their creator.
- One view per user can be marked as the default, applied automatically on load.
- We should track how often each view is used so we can later surface popular ones.

Out of scope for v1: scheduling a view to be emailed, cross-org sharing.`;

const ONE_LINER = "Add a keyboard shortcut (press '.') to toggle the sidebar open and closed.";

const BUILD_CONTEXT = `You are working inside the Spec "spec-eval" — Saved Views for the reports list.
Phase: build.

Sections: Scope, Design & UX, Architecture & Security, Testing.

Open decisions:
- dec-1: "Are saved views private by default, or shared with the org by default?" (status: OPEN)

Acceptance criteria:
- ac-1: A user can save the current filter set as a named view. (active, unverified)
- ac-2: Selecting a saved view applies its filters. (active, unverified)

Tasks: none yet.`;

const IN_SPEC_ASK =
  "Two things: (1) create a task to build the SavedViewsDropdown component in the reports list, " +
  "and (2) resolve dec-1 in favour of private-by-default (a user can opt to share afterwards).";

const STANDARDS_CONTEXT = `Standards corpus for mindset-prod/memex-building-itself (excerpt).
Existing standards:
- std-8: Every mutation goes through mutate() and emits on the unified bus.
- std-32: The activity contract — WHEN/WHO/HOW/WHAT on every activity-bearing table.
No existing standard covers timestamp storage conventions.`;

const STANDARDS_ASK =
  "Create a standard capturing that every timestamp we persist to the database must be " +
  "stored in UTC (columns are timestamptz; conversion to local time happens only at the UI edge).";

const creationSystem = buildCreationSystemBlocks();
const creationTools = getCreationToolDefinitions();

const scenarios = [
  { name: "Rich PRD → import", userText: PRD, system: creationSystem, tools: creationTools },
  {
    name: "One-line idea → should stay light",
    userText: ONE_LINER,
    system: creationSystem,
    tools: creationTools,
  },
  {
    name: "In-Spec build → create task + resolve decision",
    userText: IN_SPEC_ASK,
    system: buildSystemBlocks(BUILD_CONTEXT, "build"),
    tools: getToolDefinitions(),
  },
  {
    // Doc-less mode probe: the standards agent (scopedMode overlay + MODE_TOOLS subset).
    // buildSystemBlocks args: (documentContext, phase, readOnly, reviewer, driftMode,
    // integrationState, scaffoldMode, scopedMode).
    name: "Doc-less mode → standards agent authors a standard",
    userText: STANDARDS_ASK,
    system: buildSystemBlocks(STANDARDS_CONTEXT, "specify", false, false, false, undefined, false, "standards"),
    tools: getToolDefinitions({ mode: "standards" }),
  },
];

// Optional filter: `tsx scripts/eval-agent-sonnet5.ts <substring>` runs only matching
// scenarios (avoids re-paying for the slow creation calls when iterating).
const only = process.argv[2]?.toLowerCase();
for (const s of scenarios) {
  if (only && !s.name.toLowerCase().includes(only)) continue;
  await runScenario(s as Any);
}

console.log("\nDone.\n");
