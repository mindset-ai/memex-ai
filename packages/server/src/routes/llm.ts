import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod/v4";
import "dotenv/config";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { getAnthropicClient, LlmNotConfiguredError } from "../agent/anthropic-client.js";
import { buildDocumentContext, buildDriftContext } from "../agent/context-builder.js";
import { buildSystemBlocks, buildCreationSystemBlocks } from "../agent/system-prompt.js";
import { getToolDefinitions, getCreationToolDefinitions, executeServerTool, isToolAllowedForReviewer, isReadOnlyTool, isDriftModeTool } from "../agent/tools.js";
import { logRequest, logResponse, logError, logToolExecution, logExtractionOutcome } from "../agent/logger.js";
import { stripDanglingToolUses } from "../agent/messages.js";
import { getOrCreateConversation, getMessages, clearConversation, replaceMessages } from "../services/conversations.js";
import type { SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { canWriteMemex, READ_ONLY_PUBLIC_MESSAGE } from "../mcp/auth.js";
import { resolveRole } from "../services/doc-members.js";
import { resolveIntegrationState } from "../agent/integration-state.js";

const MODEL = "claude-sonnet-4-5-20250929";

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
   *  subset. The React UI's Drift Inbox sends this. */
  mode: z.literal("drift").optional(),
});

llmRouter.post("/chat", async (c) => {
  console.log("[LLM PROXY] /chat hit — LangGraph client-side branch");
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { docId, messages, mode } = parsed.data;
  const driftMode = mode === "drift";
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
  // No-doc branch (creation-style fallback into /chat) defaults to `plan` —
  // the prompt is generic enough and /chat/create is the primary creation
  // route anyway.
  const memexId = requireMemexId(c);
  // spec-143 t-4 (dec-6): drift mode is memex-scoped, not doc-scoped — there is
  // no bound doc. The context is the open-drift summary; the doc / creation
  // branches are skipped.
  const documentContext = driftMode
    ? await buildDriftContext(memexId)
    : docId
    ? await buildDocumentContext(memexId, docId)
    : {
        context:
          "No document loaded. The user wants to create a new document. Ask for the document title, type (e.g. spec, guide, plan), and purpose. Then use the create_doc tool to create it.",
        phase: "plan" as const,
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
  const [readOnly, reviewer, integrationState] = await Promise.all([
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
  ]);

  const systemBlocks = buildSystemBlocks(
    documentContext.context,
    documentContext.phase,
    readOnly,
    reviewer,
    driftMode,
    integrationState,
  );
  // dec-3 definition filter: a reviewer's model never sees the blocked mutations.
  // spec-143 t-4 (dec-6): in drift mode the model sees only the focused drift
  // tool subset (+ UI tools).
  const tools = getToolDefinitions({ reviewer, mode: driftMode ? "drift" : undefined });

  // Defeat any proxy / reverse-proxy buffering that might batch our SSE writes.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  logRequest("chat", messages as MessageParam[]);

  return streamSSE(c, async (stream) => {
    try {
      const anthropicStream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        tools: tools as Anthropic.Tool[],
        messages: messages as MessageParam[],
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

  const systemBlocks = buildCreationSystemBlocks();
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
        max_tokens: 4096,
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
   *  a drift-mode call can't reach beyond its surface. */
  mode: z.literal("drift").optional(),
});

llmRouter.post("/tools/execute", async (c) => {
  const body = await c.req.json();
  const parsed = toolExecSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { toolName, input, docId, mode } = parsed.data;
  const driftMode = mode === "drift";
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

  // spec-143 t-4 (dec-6): in drift mode there is no bound doc — the doc-based
  // reviewer-role gate below is skipped (it only fires when docId is set). Pin
  // the surface instead: only the focused drift subset may execute, so a
  // drift-mode call can't reach a doc/decision/task/phase mutation. UI tools
  // never hit this endpoint (they're resolved client-side), so they aren't
  // listed in the subset. Fail closed on anything else.
  if (driftMode && !isDriftModeTool(toolName)) {
    const message = `Tool "${toolName}" is not available in drift mode. The drift agent can search, read, flag drift, and propose Standard changes.`;
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

