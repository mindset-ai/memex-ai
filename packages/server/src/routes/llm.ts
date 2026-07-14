import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod/v4";
import "dotenv/config";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { getAnthropicClient, LlmNotConfiguredError } from "../agent/anthropic-client.js";
import { buildDocumentContext, buildDriftContext, buildScaffoldContext, buildStandardsContext, buildIssuesContext, buildSkillsContext } from "../agent/context-builder.js";
import { buildSystemBlocks, buildCreationSystemBlocks } from "../agent/system-prompt.js";
import { getToolDefinitions, getCreationToolDefinitions, executeServerTool, isToolAllowedForReviewer, isReadOnlyTool, isToolAllowedInMode } from "../agent/tools.js";
import { logRequest, logResponse, logError, logToolExecution, logExtractionOutcome } from "../agent/logger.js";
import { stripDanglingToolUses } from "../agent/messages.js";
import { getOrCreateConversation, getMessages, clearConversation, replaceMessages } from "../services/conversations.js";
import type { SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { canWriteMemex, READ_ONLY_PUBLIC_MESSAGE } from "../mcp/auth.js";
import { resolveRole } from "../services/doc-members.js";
import { vocabForMemex } from "../services/facet-vocab.js";
import { resolveIntegrationState } from "../agent/integration-state.js";
// spec-482 (t-4 / t-5 / t-8): the per-user opening-posture signals — both DERIVED,
// monotonic facts (no client input, no sticky flag). hasEverUsedMcp gates the
// connect-handoff tier; getPhaseHighWaterMark gates which single phase the agent teaches.
import { hasEverUsedMcp } from "../services/mcp-connection.js";
import { getPhaseHighWaterMark } from "../services/phase-watermark.js";

// spec-473: the creation + in-Spec agent runs on Sonnet 5 (was Sonnet 4.5). For
// agentic/tool-calling work it's both faster and more capable than 4.5, so the
// document→structured-Spec conversion gets quicker without trading structuring
// quality. Routed through getAnthropicClient() (the metering wrapper, std-30) —
// this const is the only model knob; never construct `new Anthropic()`.
//
// ⚠️ Thinking is set to { type: 'adaptive' } at every call site below. We first
// tried { type: 'disabled' } to preserve 4.5's no-thinking latency, but Sonnet 5's
// own guidance is that WITH THINKING OFF it reaches for tools less readily — and
// this entire surface is tool-driven (search_memex → create_doc → add_section /
// create_decision / create_ac; resolve_decision; create_task; …). Reliable
// tool-calling matters more than the latency saving, so adaptive thinking is on;
// effort is left at Sonnet 5's default. Dial depth down via output_config.effort
// if latency needs tuning. (Sonnet 5 rejects non-default temperature/top_p/top_k —
// we set none.)
const MODEL = "claude-sonnet-5";

// spec-482 follow-up — the REAL connect-MCP command for the disconnected opening tier,
// derived host-aware (mirrors packages/ui/src/utils/mcpUrl.ts + ConnectAgentStep's
// unified installer, spec-430). `APP_BASE_URL` is the public host Cloud Run injects per
// env (same var app.ts uses for install.sh). The bare `npx -y memex-ai install` command
// is prod; any other host passes `--api-base`. The agent copies this VERBATIM into its
// render_handoff so the user copies a working installer, not an LLM paraphrase.
function deriveConnectMcp(): { installCommand: string; mcpUrl: string } {
  const base = process.env.APP_BASE_URL ?? "https://int.memex.ai";
  const apiBaseFlag = base === "https://memex.ai" ? "" : ` --api-base ${base}`;
  return {
    installCommand: `npx -y memex-ai install${apiBaseFlag}`,
    mcpUrl: `${base}/mcp`,
  };
}

type Env = MemexResolverEnv & SessionEnv;

// std-5 exemption: this router mounts under both /api/<ns>/<mx>/llm (path-prefixed,
// preferred per F.3 of doc-15) and the flat /api/llm. The flat mount stays viable
// because:
//   - /chat takes an optional docId. With docId the memex is resolved via the doc FK
//     in buildDocumentContext; without docId we're in creation phase and the caller's
//     single-membership inference (currentMemexId from sessionMiddleware) supplies it.
//   - /chat/create has no docId; same single-membership inference applies.
//   - /tools/execute and /conversations* read currentMemexId for memex scoping.
// Multi-membership callers must hit the path-prefixed mount.
export const llmRouter = new Hono<Env>();

// ──────────────────────────────────────────────
// POST /chat — LLM proxy (streams SSE back)
// ──────────────────────────────────────────────

const chatSchema = z.object({
  docId: z.uuid().optional(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.any(),
  })),
  /** spec-143 t-4 (dec-6): when `'drift'`, the in-app agent runs in drift mode —
   *  no doc is bound (docId null), the context is the open-drift summary, the
   *  prompt carries the drift guidance, and the tool set is the focused drift
   *  subset. The React UI's Drift Inbox sends this.
   *  spec-360 t-1 (dec-1/dec-6): when `'scaffold'`, the in-app agent runs as the
   *  scaffold assistant — no doc is bound, the context is the composed scaffold
   *  grounding, the prompt carries the scaffold guidance, and the tool set is the
   *  focused scaffold subset. The React UI's Scaffold Inspect surface sends this.
   *  spec-389 t-5 (dec-2): `'standards'` / `'issues'` are the new scoped agents —
   *  memex-scoped (no bound doc), each with its grounding context, mode block, and
   *  MODE_TOOLS subset. The Standards / Issues surfaces send these.
   *  spec-300 t-15 (dec-23): `'skills'` is the dedicated skills authoring / curation
   *  agent that lives on the Skills page — memex-scoped, grounded in the skill
   *  catalogue, tool set pinned to SKILLS_SERVER_TOOLS. The Skills surface sends it. */
  mode: z.enum(["drift", "scaffold", "standards", "issues", "skills"]).optional(),
  /** spec-482 (t-4 / t-8): the entry framing for the in-Spec agent's opening turn.
   *  `true` when the user has just landed here after creating the Spec — the agent
   *  opens with a shallow, state-computed recap of what's still open (t-4). Absent /
   *  `false` is a normal return visit — a fixed-shape reorientation from the same
   *  signals (t-8). The tier signals (mcpConnected, phaseWatermark) are computed
   *  SERVER-side from the authenticated user; the client sends only this flag. */
  creationLanding: z.boolean().optional(),
});

llmRouter.post("/chat", async (c) => {
  console.log("[LLM PROXY] /chat hit — LangGraph client-side branch");
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { docId, messages, mode, creationLanding } = parsed.data;
  const driftMode = mode === "drift";
  const scaffoldMode = mode === "scaffold";
  const standardsMode = mode === "standards";
  const issuesMode = mode === "issues";
  const skillsMode = mode === "skills";
  console.log(
    `[LLM PROXY] docId=${docId ?? "none"}, messages=${messages.length}, mode=${mode ?? "spec"}`,
  );

  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return c.json({ error: "LLM unavailable", message: err.message }, 503);
    }
    throw err;
  }

  // Build system prompt + tools server-side (keeps caching & context assembly here).
  // The doc's BriefPhase picks which `phases/<phase>/system.md` shard to load.
  // No-doc branch (creation-style fallback into /chat) defaults to `specify` —
  // the prompt is generic enough and /chat/create is the primary creation
  // route anyway.
  const memexId = requireMemexId(c);
  // spec-143 t-4 (dec-6): drift mode is memex-scoped, not doc-scoped — there is
  // no bound doc. The context is the open-drift summary; the doc / creation
  // branches are skipped.
  // spec-360 t-1 (dec-1): scaffold mode is memex-scoped, not doc-scoped — there
  // is no bound doc. The context is the composed scaffold grounding (cached).
  // spec-389 t-5 (dec-2): standards / issues modes are memex-scoped like drift /
  // scaffold — their grounding is the Standards corpus / open-Issues parking lot.
  // spec-300 t-15 (dec-23): skills mode is memex-scoped like the other scoped
  // agents — its grounding is the Memex's skill catalogue (buildSkillsContext).
  const documentContext = standardsMode
    ? await buildStandardsContext(memexId)
    : issuesMode
    ? await buildIssuesContext(memexId)
    : skillsMode
    ? await buildSkillsContext(memexId)
    : scaffoldMode
    ? await buildScaffoldContext(memexId)
    : driftMode
    ? await buildDriftContext(memexId)
    : docId
    ? await buildDocumentContext(memexId, docId)
    : {
        context:
          "No document loaded. The user wants to create a new document. Ask for the document title, type (e.g. spec, guide, plan), and purpose. Then use the create_doc tool to create it.",
        phase: "specify" as const,
      };

  // spec-111 t-9 (dec-2): a signed-in NON-member chatting on a public Memex
  // gets the read-only agent posture — it can answer/search but must explain it
  // cannot mutate. `currentUserId` is always non-null here (strict
  // sessionMiddleware), but write access is per-Memex: derive it from
  // canWriteMemex against the resolved memex. Members → false (default), so the
  // member prompt is unchanged. Server-side enforcement still lives in the MCP
  // read/write gate (t-4); this is the prompt-level counterpart.
  // spec-180: all three pre-LLM lookups (write-access, role, integration state)
  // are independent — run them in parallel to eliminate sequential DB round trips.
  const currentUserId = c.get("currentUserId");
  // spec-482 (t-4 / t-5 / t-8): the opening posture is ONLY for the primary Spec
  // agent chatting on a bound doc — never a scoped/scaffold/drift mode, and never the
  // doc-less creation fallback. When it applies we derive the two per-user tier
  // signals server-side (the client sends only `creationLanding`); otherwise we skip
  // the queries entirely. Both signals fail-open to their least-experienced default.
  const wantOpeningPosture = !mode && !!docId && !!currentUserId;
  const [readOnly, reviewer, integrationState, mcpConnected, phaseWatermark] = await Promise.all([
    // spec-111 t-9 (dec-2): a signed-in NON-member chatting on a public Memex
    // gets the read-only agent posture — it can answer/search but must explain it
    // cannot mutate. Members → false (default). Server-side enforcement still lives
    // in the MCP read/write gate (t-4); this is the prompt-level counterpart.
    currentUserId
      ? canWriteMemex(currentUserId, memexId).then(can => !can).catch(() => false)
      : Promise.resolve(false),
    // spec-126 (dec-1/dec-2): the review overlay. Role derived SERVER-side from
    // doc_members — never client-passed (ac-3). Only doc-bound chats have a role;
    // creation fallback is never review mode. Fail-open to editor for PROMPT overlay
    // only — /tools/execute re-derives role authoritatively.
    docId && currentUserId
      ? resolveRole(memexId, docId, currentUserId).then(r => r === "reviewer").catch(() => false)
      : Promise.resolve(false),
    // spec-180: inject accurate Slack/Discord state so the agent never hallucinates
    // about tool availability. Fail-open (both not configured) on any DB error so a
    // lookup failure never hangs the route.
    resolveIntegrationState(memexId, currentUserId ?? undefined).catch(() => ({
      slackConnected: false,
      discordConnected: false,
      discordAmbiguous: false,
      discordChannelName: null,
    })),
    // spec-482 t-5 (dec-5): the MCP-connection tier gate. Fail-open to `false` (the
    // loudest connect-handoff tier) so a lookup hiccup never suppresses the handoff.
    wantOpeningPosture
      ? hasEverUsedMcp(currentUserId as string).catch(() => false)
      : Promise.resolve(false),
    // spec-482 t-5 (dec-6): the phase high-water mark. Fail-open to `'none'` (teach
    // build) — the safe least-experienced default if the derived query errors.
    wantOpeningPosture
      ? getPhaseHighWaterMark(currentUserId as string).catch(() => "none" as const)
      : Promise.resolve("none" as const),
  ]);

  // spec-482 (t-4 / t-8): assemble the opening posture only where it applies. The
  // entry framing comes from the client's `creationLanding` flag (landing recap vs
  // return-visit reorientation); the tier signals were derived above.
  const openingPosture = wantOpeningPosture
    ? {
        entry: (creationLanding ? "landing" : "return") as "landing" | "return",
        mcpConnected,
        phaseWatermark,
        // spec-482 follow-up: only the MCP-disconnected tier needs the real connect
        // command; deriving it host-aware here (mirrors the client's mcpUrl.ts) means
        // the agent's render_handoff copies a WORKING installer, not a paraphrase.
        connectMcp: mcpConnected ? undefined : deriveConnectMcp(),
      }
    : undefined;

  const systemBlocks = buildSystemBlocks(
    documentContext.context,
    documentContext.phase,
    readOnly,
    reviewer,
    driftMode,
    integrationState,
    scaffoldMode,
    standardsMode
      ? "standards"
      : issuesMode
      ? "issues"
      : skillsMode
      ? "skills"
      : undefined,
    // spec-482 (t-4 / t-5 / t-8): the primary Spec agent's opening posture (undefined
    // for scoped/scaffold/drift modes and the doc-less creation fallback).
    openingPosture,
  );
  // dec-3 definition filter: a reviewer's model never sees the blocked mutations.
  // spec-143 t-4 (dec-6): in drift mode the model sees only the focused drift
  // tool subset (+ UI tools).
  // spec-360 t-1 (dec-1): in scaffold mode the model sees only the focused scaffold
  // tool subset (propose_scaffold_change / search_memex / get_doc + UI tools), so
  // create_doc and other doc tools don't bleed in. (A 2026-06-23 Anthropic incident
  // briefly 500'd restricted tool subsets, forcing a temporary full-toolset
  // workaround here; it has since cleared — verified the scaffold subset passes
  // 5/5 against the live API — so the real subset is restored.)
  const tools = getToolDefinitions({
    reviewer,
    // spec-389 t-3/t-5: the model sees only the active mode's MODE_TOOLS subset.
    mode: mode ?? undefined,
  });

  // Defeat any proxy / reverse-proxy buffering that might batch our SSE writes.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  // Strip any tool_use blocks that have no matching tool_result — happens when
  // the user types a follow-up message instead of acting on a compose widget,
  // leaving an orphaned tool_use in history that Anthropic rejects with 400.
  const sanitisedMessages = stripDanglingToolUses(messages as MessageParam[]);

  logRequest("chat", sanitisedMessages);

  return streamSSE(c, async (stream) => {
    try {
      const anthropicStream = anthropic.messages.stream({
        model: MODEL,
        // spec-473: 8192 (was 4096) for symmetry with /chat/create — Sonnet 5's
        // heavier tokenizer + a thinking budget leave less room, and a long
        // in-Spec turn shouldn't truncate at max_tokens.
        max_tokens: 8192,
        // Adaptive thinking on — keeps Sonnet 5 reaching for tools. See MODEL note.
        thinking: { type: "adaptive" },
        system: systemBlocks,
        tools: tools as Anthropic.Tool[],
        messages: sanitisedMessages,
      });

      // Event-listener pattern — mirrors `doc-events.ts`, the other SSE endpoint
      // in this codebase that streams flawlessly. Each text delta fires the
      // callback synchronously and writes immediately; no for-await loop holds
      // the stream handler, so nothing batches. Fire-and-forget writeSSE (no
      // await) matches the doc-events pattern and lets Hono flush between
      // deltas rather than once the whole handler resolves.
      anthropicStream.on("text", (text: string) => {
        stream.writeSSE({
          event: "text_delta",
          data: JSON.stringify({ text }),
        });
      });

      const final = await anthropicStream.finalMessage();
      logResponse("chat", final);
      logExtractionOutcome("chat", final, { docId: docId ?? null });

      await stream.writeSSE({
        event: "message_complete",
        data: JSON.stringify({
          content: final.content as ContentBlockParam[],
          stopReason: final.stop_reason,
        }),
      });
    } catch (err) {
      logError("chat", err);
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});

// ──────────────────────────────────────────────
// POST /chat/create — LLM proxy for doc creation phase
// ──────────────────────────────────────────────

// spec-473: a short, human-facing label for the live "Building your Spec…"
// checklist in the creation modal. Emitted per tool block as the model finishes
// WRITING it (before execution), so the user sees rows tick in during the single
// batched authoring turn (creation/system.md step 4) instead of a long silent
// wait. Terse label only — never the full section body.
function toolProgressLabel(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const clip = (v: string, n = 64): string => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
  switch (name) {
    case "search_memex":
      return "Searching related work";
    case "create_doc":
      return clip(s(input.title) || "the Spec");
    case "add_section":
      return `${clip(s(input.title) || s(input.sectionType) || "section")} section`;
    case "create_decision":
      return `Decision — ${clip(s(input.title) || "decision")}`;
    case "create_ac":
      return `Criterion — ${clip(s(input.statement) || "acceptance criterion")}`;
    default:
      return name;
  }
}

const createChatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.any(),
  })),
});

llmRouter.post("/chat/create", async (c) => {
  console.log("[LLM PROXY] /chat/create hit — creation phase");
  const body = await c.req.json();
  const parsed = createChatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { messages } = parsed.data;

  let anthropic: Anthropic;
  try {
    anthropic = getAnthropicClient();
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return c.json({ error: "LLM unavailable", message: err.message }, 503);
    }
    throw err;
  }

  // spec-473: inject this Memex's facet vocabulary so the creation agent can cast the
  // complete facet ballot that `create_decision` hard-requires (spec-423 dec-5). The
  // creation surface omits the `facets` tool (to keep step-4 authoring one batched
  // turn), so without this the agent can't comply and every decision is rejected.
  // Best-effort: on any resolution/load hiccup, fall back to no facet block (the prior
  // behaviour) rather than blocking creation — the empty-vocab path is a no-op anyway.
  let facetVocab: Awaited<ReturnType<typeof vocabForMemex>> = [];
  try {
    facetVocab = await vocabForMemex(requireMemexId(c));
  } catch (err) {
    logError("chat/create", err);
  }

  const systemBlocks = buildCreationSystemBlocks(facetVocab);
  const tools = getCreationToolDefinitions();

  // The creation flow has no LangGraph resume path — if the prior assistant
  // turn ended on an interactive UI tool (e.g. `render_confirmation`) and the
  // user typed past the widget instead of clicking it, the dangling `tool_use`
  // would 400 Anthropic ("tool_use ids were found without tool_result blocks
  // immediately after"). Drop those orphaned blocks before sending. Mirrors
  // CLAUDE.md's promise that non-resume history loads strip dangling tool_use.
  const sanitisedMessages = stripDanglingToolUses(messages as MessageParam[]);

  // Defeat any proxy / reverse-proxy buffering that might batch our SSE writes.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  logRequest("chat/create", sanitisedMessages);

  return streamSSE(c, async (stream) => {
    try {
      const anthropicStream = anthropic.messages.stream({
        model: MODEL,
        // spec-473: raised from 4096 so the batched authoring turn (many
        // add_section / create_decision / create_ac blocks emitted at once —
        // see creation/system.md step 4) has room to fan out without truncating.
        max_tokens: 8192,
        // Adaptive thinking on — keeps Sonnet 5 reaching for tools. See MODEL note.
        thinking: { type: "adaptive" },
        system: systemBlocks,
        tools: tools as Anthropic.Tool[],
        messages: sanitisedMessages,
      });

      // See the matching comment in /chat above — this is the event-listener
      // pattern copied from doc-events.ts, the reference SSE in this repo.
      anthropicStream.on("text", (text: string) => {
        stream.writeSSE({
          event: "text_delta",
          data: JSON.stringify({ text }),
        });
      });

      // spec-473: forward each tool block the moment the model finishes WRITING
      // it, so the creation modal ticks rows into a live checklist DURING the
      // single batched authoring turn (creation/system.md step 4) — restoring the
      // incremental feedback batching would otherwise collapse into one long
      // silent "Working…". Fire-and-forget, same as the text handler.
      anthropicStream.on("contentBlock", (block) => {
        if (block.type !== "tool_use") return;
        stream.writeSSE({
          event: "tool_progress",
          data: JSON.stringify({
            name: block.name,
            id: block.id,
            label: toolProgressLabel(
              block.name,
              (block.input ?? {}) as Record<string, unknown>,
            ),
          }),
        });
      });

      const final = await anthropicStream.finalMessage();
      logResponse("chat/create", final);

      await stream.writeSSE({
        event: "message_complete",
        data: JSON.stringify({
          content: final.content as ContentBlockParam[],
          stopReason: final.stop_reason,
        }),
      });
    } catch (err) {
      logError("chat/create", err);
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});

// ──────────────────────────────────────────────
// POST /tools/execute — Server tool executor
// ──────────────────────────────────────────────

const toolExecSchema = z.object({
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** The doc UUID the chat is bound to. Sent by the in-app React agent;
   *  omitted during the creation phase. Threaded into the tool ctx so
   *  `search_memex` can exclude self-hits by default (b-34 T-12). */
  docId: z.uuid().optional(),
  /** spec-143 t-4 (dec-6): when `'drift'`, the call is from the drift agent.
   *  Drift tools are memex-scoped via their input (standardId/sectionId), not
   *  doc-scoped, so they run with docId null — the doc-based reviewer-role gate
   *  is skipped. We additionally restrict execution to the drift tool subset so
   *  a drift-mode call can't reach beyond its surface.
   *  spec-360 t-1 (dec-1): when `'scaffold'`, the call is from the scaffold
   *  assistant — memex-scoped, no bound doc, restricted to the scaffold subset.
   *  spec-389 t-3 (dec-2): `'standards'` / `'issues'` are the new scoped agents,
   *  each memex-scoped and pinned to its own MODE_TOOLS subset by the gate.
   *  spec-300 t-15 (dec-23): `'skills'` is pinned to SKILLS_SERVER_TOOLS the same
   *  way — this enum MUST accept it too, else /tools/execute 400s while /chat works. */
  mode: z.enum(["drift", "scaffold", "standards", "issues", "skills"]).optional(),
});

llmRouter.post("/tools/execute", async (c) => {
  const body = await c.req.json();
  const parsed = toolExecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { toolName, input, docId, mode } = parsed.data;
  const user = c.get("user");
  const userId = user.id;
  const memexId = requireMemexId(c);

  // spec-126 ac-15/ac-16 — the WRITE-CAPABILITY gate. Enforced INDEPENDENTLY of
  // role and BEFORE it: a viewer who cannot write the Memex (canWriteMemex →
  // false: a signed-in non-member on a public Memex, who defaults to `reviewer`
  // per ac-4) is read-only EVERYWHERE. Every mutating tool is rejected here —
  // including the reviewer write allow-list (add_comment/update_comment/
  // register_issue) and all state changes — so the allow-list only ever applies
  // on TOP of write capability (ac-16), never to a non-writer (ac-15). This is
  // the in-app counterpart of the MCP route's enforceWriteGate (mcp/tools.ts);
  // spec-111 only wired readOnly into the PROMPT here, not execution (i-1).
  // Fail closed: a canWriteMemex error resolves to no-write. memexId/userId are
  // always in scope, so the gate does not depend on a bound doc. [per std-4]
  // org membership is the write ceiling; [per std-8] a blocked call never reaches
  // mutate()/the bus.
  const canWrite = await canWriteMemex(userId, memexId).catch(() => false);
  if (!canWrite && !isReadOnlyTool(toolName)) {
    logToolExecution(toolName, input, { error: READ_ONLY_PUBLIC_MESSAGE });
    return c.json({ error: READ_ONLY_PUBLIC_MESSAGE }, 403);
  }

  // spec-389 t-3 (dec-2): the per-mode surface gate, generalised from the
  // drift/scaffold-specific checks into ONE map-driven rule. A scoped mode
  // (drift / scaffold / standards / issues) is memex-scoped with no bound doc —
  // the doc-based reviewer-role gate below is skipped (it only fires when docId
  // is set), so we pin the surface here: only the active mode's MODE_TOOLS
  // subset may execute, so a scoped-mode call can't reach beyond its function.
  // `spec` (and an absent mode) is unrestricted here and governed by the
  // write-capability + reviewer-role gates instead. UI tools never hit this
  // endpoint (resolved client-side). Fail closed on anything else. [per std-8]
  // a blocked call never reaches mutate()/the bus.
  if (mode && !isToolAllowedInMode(mode, toolName)) {
    const message = `Tool "${toolName}" is not available in ${mode} mode. Each in-app agent is scoped to its own function — search and read are always available, but authoring is limited to the agent's domain.`;
    logToolExecution(toolName, input, { error: message });
    return c.json({ error: message }, 403);
  }

  // spec-126 dec-3 — the authoritative review enforcement (ac-6). This is the
  // single execution chokepoint for the in-app agent's server tools, so the gate
  // lives here rather than inside executeServerTool (which is exercised directly
  // by many tests with their own role posture). Role is re-derived SERVER-side
  // from doc_members, independent of the /chat definition filter, so a hand-
  // crafted call to a blocked tool is REJECTED before any handler / mutate() /
  // bus emission (std-8). Allowed tools (read/search/comment) pass (ac-7). No
  // .catch here: if the role can't be resolved the request errors and nothing
  // mutates (fail closed).
  if (docId) {
    const role = await resolveRole(memexId, docId, userId);
    if (role === "reviewer" && !isToolAllowedForReviewer(toolName)) {
      const message = `Tool "${toolName}" is not permitted in review mode — reviewers can read, search, comment, @mention, and raise Issues, but cannot make forward-driving changes.`;
      logToolExecution(toolName, input, { error: message });
      return c.json({ error: message }, 403);
    }
  }

  try {
    // userId is the UUID — services that write `createdByUserId` (e.g.
    // createDocDraft, createStandard) need the row id, not the email. The
    // pre-doc-14 code passed `userEmail || userId` which silently wrote the
    // email into a UUID column and failed at insert time with
    // `invalid input syntax for type uuid: "<email>"` for any chat-driven
    // create_doc call.
    // spec-126 change-10: pass the acting user's display name so user-authored
    // artifacts (comments) are attributed to them, not "Memex agent".
    const userName = user.name ?? user.email;
    const result = await executeServerTool(memexId, toolName, input, userId, docId, userName);
    logToolExecution(toolName, input, { result });
    return c.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logToolExecution(toolName, input, { error: message });
    return c.json({ error: message }, 400);
  }
});

// ──────────────────────────────────────────────
// POST /conversations — Save full conversation
// ──────────────────────────────────────────────

const saveConversationSchema = z.object({
  docId: z.uuid(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.any(),
  })),
});

llmRouter.post("/conversations", async (c) => {
  const body = await c.req.json();
  const parsed = saveConversationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { docId, messages: msgs } = parsed.data;
  const user = c.get("user"); const userId = user.id;

  const conversation = await getOrCreateConversation(requireMemexId(c), docId, userId);

  // std-8 / spec-156 ac-14: persist exclusively through the mutate()-wrapped
  // conversation service. replaceMessages folds the replace-all (delete + seq'd
  // reinsert) into one mutate() so saving a chat turn emits
  // conversation_message.created — the raw db.delete/db.insert that bypassed the
  // bus is gone.
  await replaceMessages(conversation.id, msgs, { channel: "rest_ui" });

  return c.json({ ok: true, messageCount: msgs.length });
});

// ──────────────────────────────────────────────
// GET /conversations/:docId — Load conversation
// ──────────────────────────────────────────────

llmRouter.get("/conversations/:docId", async (c) => {
  const docId = c.req.param("docId");
  const user = c.get("user"); const userId = user.id;

  const conversation = await getOrCreateConversation(requireMemexId(c), docId, userId);
  const stored = await getMessages(conversation.id);

  const messages = stored.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return c.json({ messages });
});

// ──────────────────────────────────────────────
// POST /conversations/:docId/clear — Clear conversation
// ──────────────────────────────────────────────

llmRouter.post("/conversations/:docId/clear", async (c) => {
  const docId = c.req.param("docId");
  const user = c.get("user"); const userId = user.id;

  const conversation = await getOrCreateConversation(requireMemexId(c), docId, userId);
  await clearConversation(conversation.id);

  return c.json({ ok: true });
});

