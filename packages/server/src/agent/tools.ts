// doc-2 t-1: thin agent adapter over the canonical tool-specs catalogue.
//
// Source of truth for the shared 30 tools is `agent/tool-specs.ts`. This file
// owns:
//   - The 6 `render_*` UI tool definitions (no MCP analog — they pause the
//     loop and require a user click before resuming).
//   - The agent ctx: `verbose: false`, `resolveMemex` validates the entity
//     belongs to the bound memexId, `resolveMemex` returns the bound
//     memexId regardless of the `memex` arg.
//   - `getToolDefinitions()` / `getCreationToolDefinitions()` — Anthropic
//     tool definitions, derived from the specs by a hand-rolled zod →
//     JSON-Schema converter (see toJsonSchema below).
//   - `executeServerTool()` — dispatch by name to spec.handler with the
//     agent ctx.
//
// Per dec-4 of doc-14 the regression test in
// `__regression__/tools-coverage.regression.test.ts` enforces parity with
// the MCP surface. Keep this list and the spec catalogue in lockstep.

import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import {
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import {
  toolSpecs,
  buildNudgeOrgBlocksGetter,
  type ResolvedRef,
  type ToolCtx,
  type ToolSpec,
  type EntityKind,
} from "./tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { emitInAppAgentActivity } from "../services/conversations.js";
import { runToolWithSpecTraffic } from "../services/spec-traffic.js";
import { deriveActivity } from "./derive-activity.js";

// ══════════════════════════════════════
// Anthropic tool-definition shape
// ══════════════════════════════════════

/** Anthropic Tool schema — matches @anthropic-ai/sdk Tool type. */
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  cache_control?: { type: string };
}

// ══════════════════════════════════════
// Zod → JSON Schema
// ══════════════════════════════════════
//
// Zod 4 ships `z.toJSONSchema()` — a faithful, in-tree converter that already
// handles the subset we use (z.string / z.number / z.boolean / z.literal /
// z.enum / z.array / z.object / z.union / .optional() / .nullable() /
// .describe() / .default()) and emits descriptions correctly.
//
// We don't pull in `zod-to-json-schema` (per the zero-dep rule on this repo —
// see project memory + CLAUDE.md) because we don't need to: the converter is
// part of the zod package we already depend on. The thin wrapper below
// post-processes the output into the exact `{type:'object', properties,
// required}` shape Anthropic's Tool definition expects, dropping zod's
// `$schema` / `additionalProperties` annotations that would otherwise leak
// through.

interface AnthropicInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

function buildToolFromSpec(spec: ToolSpec): Tool {
  // Wrap the raw shape in a ZodObject so toJSONSchema sees the right
  // optional/required computation at the top level.
  const objectSchema = z.object(spec.schema as Parameters<typeof z.object>[0]);
  // toJSONSchema returns a JSON-schema-shaped object; cast through unknown
  // because the public type is intentionally narrow.
  const raw = z.toJSONSchema(objectSchema) as unknown as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    $schema?: string;
  };
  const input_schema: AnthropicInputSchema = {
    type: "object",
    properties: stripJsonSchemaMetadata(raw.properties ?? {}),
  };
  if (raw.required && raw.required.length > 0) {
    input_schema.required = raw.required;
  }
  return { name: spec.name, description: spec.description, input_schema };
}

// Recursively drop zod-emitted JSON-schema-draft annotations Anthropic doesn't
// want (`$schema`, `additionalProperties`) so the tool definition is the
// minimal shape the SDK expects.
function stripJsonSchemaMetadata(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "additionalProperties") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripJsonSchemaMetadata(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? stripJsonSchemaMetadata(entry as Record<string, unknown>)
          : entry,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ══════════════════════════════════════
// UI tools (forwarded to frontend) — agent-only
// ══════════════════════════════════════
// These pause the agent loop: the server emits a `tool_use` block, SSE
// closes, the user clicks the resulting widget, and a follow-up POST
// resumes the loop with a `tool_result`. They have no MCP analog.

const uiTools: Tool[] = [
  {
    name: "render_action_buttons",
    description:
      "Present a group of action buttons for the user to choose from. Use when you need the user to pick between distinct actions.",
    input_schema: {
      type: "object" as const,
      properties: {
        buttons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Button text" },
              action: { type: "string", description: "Action identifier returned on click" },
              variant: { type: "string", enum: ["primary", "secondary", "danger"], description: "Visual style" },
            },
            required: ["label", "action"],
          },
          description: "Buttons to display",
        },
      },
      required: ["buttons"],
    },
  },
  {
    name: "render_choices",
    description: "Present options as selectable cards for the user to choose from.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The question being asked" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Option label" },
              value: { type: "string", description: "Value returned on selection" },
              description: { type: "string", description: "Optional description" },
            },
            required: ["label", "value"],
          },
          description: "Options to choose from",
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "render_confirmation",
    description: "Ask the user for yes/no confirmation before a destructive or significant action.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "What you're asking confirmation for" },
        confirmLabel: { type: "string", description: "Custom confirm button text" },
        cancelLabel: { type: "string", description: "Custom cancel button text" },
      },
      required: ["message"],
    },
  },
  {
    name: "render_progress",
    description: "Show a multi-step progress indicator for long-running operations. Display-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Step label" },
              status: { type: "string", enum: ["pending", "in_progress", "complete", "error"], description: "Step status" },
            },
            required: ["label", "status"],
          },
          description: "Steps to display",
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "render_callout",
    description:
      "Display a friendly callout box with a heading and short body. Use to break up walls of text, set expectations, reassure, or flag something important in a warm way.",
    input_schema: {
      type: "object" as const,
      properties: {
        tone: { type: "string", enum: ["info", "success", "tip", "warning"], description: "Visual tone." },
        heading: { type: "string", description: "Short heading." },
        body: { type: "string", description: "One or two sentences of body text. Markdown supported." },
      },
      required: ["heading", "body"],
    },
  },
  {
    name: "render_steps",
    description: "Display a clean numbered-steps visual for a short process or plan (3-6 steps). Display-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Optional title shown above the steps." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short step label." },
              detail: { type: "string", description: "Optional one-line detail." },
            },
            required: ["label"],
          },
          description: "Ordered steps.",
        },
      },
      required: ["steps"],
    },
  },
];

// ══════════════════════════════════════
// Exports
// ══════════════════════════════════════

// ══════════════════════════════════════
// spec-126 dec-3: reviewer capability allowance
// ══════════════════════════════════════
//
// The review overlay's enforcement (dec-3). FAIL-CLOSED: a reviewer may call any
// read-only tool (`readOnlyHint: true`) plus a short explicit allow-list of
// permitted mutations (comment / @mention / raise-Issue). EVERY other mutating
// tool is blocked — so a newly-added mutation is blocked by default, never
// silently exposed to reviewers. UI render tools are presentational (they never
// mutate) and always pass.
//
// This lives server-side because the readOnlyHint annotations do (tool-specs.ts);
// it extends spec-111's binary readOnly gate to a capability-scoped allowance
// rather than forking a parallel rail. [per std-16] the tool contract is single-
// sourced — this reads the same `toolSpecs` annotations, it does not restate them.
const REVIEWER_WRITE_ALLOWLIST = new Set<string>([
  "add_comment",
  "update_comment",
  // Raise an Issue (spec-112) — a reviewer's sanctioned way to flag a problem
  // (dec-3). The other issue verbs (update/resolve/convert) stay editor-only.
  "register_issue",
  // Slack + Discord messages — external actions, do not mutate the Spec. A
  // reviewer may ping a teammate or send a status update without editor rights.
  "memex__send_slack_message",
  "memex__send_discord_message",
  // @mention (spec-79) is NOT here — the tool isn't built, so we don't permit
  // (or advertise) it. Add it when spec-79 lands.
]);

/** dec-3: may a reviewer invoke this tool? Read-only tools and the explicit
 *  write allow-list pass; everything else (mutations) is blocked. Unknown tool
 *  names fail closed. */
export function isToolAllowedForReviewer(name: string): boolean {
  if (isUiTool(name)) return true;
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) return false; // unknown → fail closed
  if (spec.annotations.readOnlyHint) return true;
  return REVIEWER_WRITE_ALLOWLIST.has(name);
}

/** spec-126 dec-3 (ac-15): is this tool safe for a NON-writer to execute? Only
 *  presentational UI tools and `readOnlyHint` reads/search are — every server
 *  mutation is not, regardless of the reviewer allow-list. This is the predicate
 *  the in-app `/tools/execute` write gate uses to enforce read-only for a viewer
 *  who cannot write the Memex (canWriteMemex === false): the readOnly check
 *  supersedes the role allow-list, so a non-member who defaults to `reviewer`
 *  gets ZERO writes (the allow-list only ever applies on TOP of write capability).
 *  Unknown tool names fail closed (treated as mutating). [per std-16] reads the
 *  same `toolSpecs` readOnlyHint annotations — it does not restate them. */
export function isReadOnlyTool(name: string): boolean {
  if (isUiTool(name)) return true;
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) return false; // unknown → fail closed (treat as a mutation)
  return spec.annotations.readOnlyHint === true;
}

// spec-143: the focused server-tool subset the drift agent sees. The drift
// agent operates ACROSS this Memex's Standards, not on a single Spec, so it gets
// the verbs needed to understand AND handle drift — never the broad doc /
// decision / task / phase mutation surface:
//   - search_memex / get_doc — pull surrounding context + read a Standard's body.
//   - list_comments — fetch a drift / proposal comment's exact ref (c-N) so the
//     agent can act on a specific item.
//   - flag_drift / propose_standard_change — record a new finding / propose new
//     rule wording.
//   - update_section — apply a rule change by editing the Standard's section
//     (resolves the section by its s-N ref, memex-scoped).
//   - update_comment — resolve a drift / proposal comment (status='resolved' +
//     a resolution note for accept / reject / dismiss), addressed by its c-N ref.
//   - add_clause / edit_clause / delete_clause (spec-175) — apply a rule change
//     at clause grain. Standards are clause-backed (spec-150 / spec-161), so
//     update_section now hard-rejects on a Standard; these are the verbs that
//     actually let the drift agent edit rule text. The cl-N refs they need are
//     surfaced inline by get_doc.
// update_section and update_comment both resolve their target memex-scoped via
// the input ref (no bound docId needed). render_confirmation (a UI tool, always
// included below) gates EVERY mutation — the agent proposes before it writes.
const DRIFT_SERVER_TOOLS = new Set<string>([
  "flag_drift",
  "propose_standard_change",
  "search_memex",
  "get_doc",
  "list_comments",
  "update_section",
  "update_comment",
  "add_clause",
  "edit_clause",
  "delete_clause",
]);

/** All tool definitions for the Anthropic API. Last tool has cache_control.
 *  spec-126 dec-3: when `opts.reviewer` is set, blocked mutations are dropped so
 *  the model never sees them (definition filter); the /tools/execute route also
 *  gates execution as the authoritative server-side enforcement.
 *  spec-143 t-4 (dec-6): when `opts.mode === 'drift'` the server-tool surface is
 *  narrowed to the focused drift subset (DRIFT_SERVER_TOOLS); the UI tools —
 *  including render_confirmation, the mutation gate — are always included. */
export function getToolDefinitions(opts?: {
  reviewer?: boolean;
  mode?: "drift";
}): Tool[] {
  const serverTools = toolSpecs
    .filter((s) =>
      opts?.mode === "drift" ? DRIFT_SERVER_TOOLS.has(s.name) : true,
    )
    .filter((s) => !opts?.reviewer || isToolAllowedForReviewer(s.name))
    .map(buildToolFromSpec);
  const allTools = [...serverTools, ...uiTools];
  // Cache breakpoint 1: tool definitions (1h TTL).
  const last = allTools[allTools.length - 1];
  (last as Tool & { cache_control?: { type: string } }).cache_control = { type: "ephemeral" };
  return allTools;
}

/** spec-143 t-4 (dec-6): is `name` part of the drift agent's allowed surface?
 *  Used by /tools/execute to permit the drift subset to run with docId null
 *  (the drift tools are memex-scoped via their input, not doc-scoped). UI tools
 *  never execute server-side, so they aren't listed here. */
export function isDriftModeTool(name: string): boolean {
  return DRIFT_SERVER_TOOLS.has(name);
}

/** Tool definitions for the document creation phase — create_doc + add_section +
 *  search_memex (b-34 D-7: creation-phase agent needs semantic search to spot
 *  overlap before authoring a new Spec) + UI tools. */
export function getCreationToolDefinitions(): Tool[] {
  const createDocSpec = toolSpecs.find((s) => s.name === "create_doc");
  const addSectionSpec = toolSpecs.find((s) => s.name === "add_section");
  const searchMemexSpec = toolSpecs.find((s) => s.name === "search_memex");
  if (!createDocSpec) throw new Error("create_doc tool not found");
  if (!addSectionSpec) throw new Error("add_section tool not found");
  if (!searchMemexSpec) throw new Error("search_memex tool not found");
  const allTools: Tool[] = [
    buildToolFromSpec(createDocSpec),
    buildToolFromSpec(addSectionSpec),
    buildToolFromSpec(searchMemexSpec),
    ...uiTools,
  ];
  const last = allTools[allTools.length - 1];
  (last as Tool & { cache_control?: { type: string } }).cache_control = { type: "ephemeral" };
  return allTools;
}

const UI_TOOLS = new Set([
  "render_action_buttons",
  "render_choices",
  "render_confirmation",
  "render_progress",
  "render_callout",
  "render_steps",
]);

/** Returns true if the tool should be forwarded to the frontend instead of executed server-side. */
export function isUiTool(name: string): boolean {
  return UI_TOOLS.has(name);
}

// ══════════════════════════════════════
// Agent ctx: bound-account, terse-output
// ══════════════════════════════════════

/**
 * Look up the account that owns a given entity. Mirrors the lookup logic in
 * `mcp/auth.ts:resolveMemexFromEntity` but skips the membership check
 * because the agent path has already authenticated the account upstream
 * (`requireMemexId(c)` in routes/llm.ts). The bound-account-equality
 * assertion is the defence-in-depth hop.
 */
async function lookupEntityMemex(kind: EntityKind, id: string): Promise<string | undefined> {
  switch (kind) {
    case "doc": {
      const row = await db.query.documents.findFirst({
        where: eq(documents.id, id),
        columns: { memexId: true },
      });
      return row?.memexId;
    }
    case "section": {
      const row = await db
        .select({ memexId: documents.memexId })
        .from(docSections)
        .innerJoin(documents, eq(docSections.docId, documents.id))
        .where(eq(docSections.id, id))
        .limit(1);
      return row[0]?.memexId;
    }
    case "decision": {
      const row = await db.query.decisions.findFirst({
        where: eq(decisions.id, id),
        columns: { memexId: true },
      });
      return row?.memexId;
    }
    case "task": {
      const row = await db.query.tasks.findFirst({
        where: eq(tasks.id, id),
        columns: { memexId: true },
      });
      return row?.memexId;
    }
    case "comment": {
      const row = await db.query.docComments.findFirst({
        where: eq(docComments.id, id),
        columns: { memexId: true },
      });
      return row?.memexId;
    }
  }
}

function buildAgentCtx(
  memexId: string,
  userId: string,
  toolName: string,
  currentDocId?: string,
  userName?: string,
): ToolCtx {
  return {
    userId,
    userName,
    // spec-156 ac-19: this is the React in-app agent surface. Threaded into
    // any handler that derives a mutate() channel from ctx (update_doc's tag
    // writes) so Pulse attributes agent-driven activity correctly.
    channel: "in_app_agent",
    // Validates the resolved entity actually belongs to the bound memex.
    // Throws NotFoundError on a miss or a cross-tenant reference — looks
    // identical to the entity not existing, which is the right answer for
    // a UUID the user doesn't own.
    resolveMemexFromEntity: async (kind, id) => {
      const owned = await lookupEntityMemex(kind, id);
      if (!owned) {
        throw new NotFoundError(`${kind} ${id} not found.`);
      }
      if (owned !== memexId) {
        throw new NotFoundError(`${kind} ${id} not found.`);
      }
      return memexId;
    },
    // The agent loop is already memex-scoped via the route — ignore any
    // `memex` arg the LLM happens to pass and use the bound memex.
    resolveMemex: async () => memexId,
    // b-36 T-6: resolve a canonical ref and verify it lives inside the
    // bound memex. The agent loop has already authenticated the user; this
    // check is defence-in-depth against the LLM passing a ref to another
    // tenant's content.
    resolveRef: (ref: string) => resolveRefForAgent(ref, memexId),
    // Terse output never renders URLs; return empty string so any caller
    // accidentally formatting one gets a safe placeholder rather than a
    // network round-trip.
    workspaceUrl: async () => "",
    verbose: false,
    // Bound by the in-app chat route when the conversation is anchored to a
    // specific doc; undefined during the creation phase. Used by
    // `search_memex` to exclude self-hits by default.
    currentDocId,
    // b-68 t-8 / ac-29: thread the dispatching tool name + lazy Org-block
    // fetcher into the ctx so the spec phase footer (composed by
    // `toNudge` inside `formatBriefGuidance`) picks up per-tool Org
    // additions and merges them with base `BASE_SCAFFOLD` blocks. Identical
    // wiring lives on the MCP surface (`mcp/tools.ts`) — both produce the
    // same nudge text for the same (tool, phase) pair.
    toolName,
    getOrgBlocksForNudge: buildNudgeOrgBlocksGetter(() => memexId),
  };
}

async function resolveRefForAgent(
  ref: string,
  boundMemexId: string,
): Promise<ResolvedRef> {
  const parsed = parseRef(ref);
  if (!parsed.ok) {
    throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
  }
  const result = await resolveCanonicalRef(parsed.ref);
  if ("redirected" in result) {
    throw new ValidationError(
      `Ref redirected: "${ref}" now lives at "${result.newRef}". Retry with the new ref.`,
    );
  }
  if ("notFound" in result) {
    throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
  }
  const entity = result.entity;
  const doc = "doc" in entity ? entity.doc : entity.row;
  if (doc.memexId !== boundMemexId) {
    throw new NotFoundError(`Ref "${ref}" not found.`);
  }
  // spec-178 t-11 / dec-11 (ac-38): the in-app agents (the server Anthropic-SDK
  // agent per std-11, AND the React/LangGraph agent — which executes every
  // server tool through this same resolver via /tools/execute → executeServerTool)
  // must not read or act on a handhold demo spec. All doc-targeting agent tools
  // resolve their ref here, so a single not-found guard makes a demo spec inert to
  // the whole agent surface. The bound current-doc context path (buildDocumentContext
  // → getDoc) is intentionally untouched: that's the doc the user explicitly opened,
  // analogous to the board's getDoc, and is out of scope for this exclusion.
  if (doc.isDemo) {
    throw new NotFoundError(`Ref "${ref}" not found.`);
  }
  return {
    entity,
    memexId: doc.memexId,
    doc,
    slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
  };
}

// ══════════════════════════════════════
// Pulse (b-60 t-6): read/call activity derivation
// ══════════════════════════════════════
//
// The pure `deriveActivity` mapping now lives in `agent/derive-activity.ts` so
// the MCP handler wrap (`mcp/tools.ts`, spec-156 ac-15) shares the exact same
// tool→activity mapping. The only per-surface difference is the emitted event
// `channel` (`in_app_agent` here, `mcp` there).
//
// `currentDocId` is the bound doc UUID (event `docId` for doc-scoped reads).

/** Execute a server-side tool and return a formatted result string.
 *  `currentDocId` is the doc the in-app chat is bound to (optional); it's
 *  threaded into the ctx so tools like `search_memex` can default-exclude
 *  the agent's own document from results. */
export async function executeServerTool(
  memexId: string,
  name: string,
  input: Record<string, unknown>,
  userId: string,
  currentDocId?: string,
  userName?: string,
): Promise<string> {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Unknown server tool: ${name}`);
  const ctx = buildAgentCtx(memexId, userId, name, currentDocId, userName);

  // Pulse (b-60 t-6): emit a read/call activity for non-mutating tools. Fully
  // advisory — deriveActivity is pure and emitInAppAgentActivity never throws
  // or blocks (it detaches the conversation-id lookup + bus emit). Wrapped in a
  // try so a derivation bug can never break a tool turn.
  try {
    const activity = deriveActivity(spec, name, input);
    if (activity) {
      const docScoped = activity.docScoped !== false;
      emitInAppAgentActivity({
        memexId,
        docId: docScoped ? currentDocId : undefined,
        userId,
        action: activity.action,
        entity: activity.entity,
        narrative: activity.narrative,
        payload: activity.payload,
      });
    }
  } catch {
    // No-op — emission must never affect the agent turn.
  }

  // spec-189: handler execution goes through the channel-neutral traffic
  // seam — after a SUCCESSFUL call, the Spec the call resolved to may
  // auto-advance phase and auto-assign the caller (see
  // services/spec-traffic.ts). Identical wiring on the MCP surface
  // (mcp/tools.ts) per dec-5; ctx.channel ('in_app_agent' here) is what
  // distinguishes the surfaces.
  return runToolWithSpecTraffic(spec, input, ctx);
}

// Avoid unused-import warning — `and` is kept around because the lookup
// helpers may grow into compound where-clauses; keeping the import close
// to where it'd be used.
void and;
