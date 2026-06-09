// doc-2 t-1: thin MCP adapter over the canonical tool-specs catalogue.
//
// The shared 30 tools come from `agent/tool-specs.ts`. This file now only
// owns:
//   - The MCP-only `list_memexes` tool (registered inline, no spec).
//   - The McpServer instructions (`MEMEX_AGENT_INSTRUCTIONS`).
//   - A Memex-URL helper to feed verbose formatters.
//   - Adapter glue: build the ctx, register each spec via `server.tool(...)`,
//     map exceptions → MCP error results.
//
// Per dec-4 of doc-14 the regression test in
// `__regression__/tools-coverage.regression.test.ts` enforces parity between
// this surface and the agent's getToolDefinitions(). Don't add MCP-only
// tools here without bumping that test's MCP_ONLY whitelist.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listMemberships } from "../services/users.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { formatMemexList } from "./formatters.js";
import { listTopics } from "../services/guidance.js";
import {
  McpAuthError,
  READ_ONLY_PUBLIC_MESSAGE,
  assertReadAccessForMemex,
  resolveWorkspaceForRead,
  resolveMemexFromEntityForRead,
} from "./auth.js";
import { buildTenantUrl } from "../services/shared/tenant-url.js";
import { memexSlugsById } from "./refs.js";
import {
  toolSpecs,
  buildNudgeOrgBlocksGetter,
  type ToolCtx,
  type ResolvedRef,
} from "../agent/tool-specs.js";
import { applyPhaseDescriptionOverrides } from "./phase-descriptions.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { parseRef } from "../services/refs.js";
import { logToolCall } from "../services/mcp-telemetry.js";
import { runToolWithSpecTraffic } from "../services/spec-traffic.js";
import { memexContext } from "../db/connection.js";
import { bus } from "../services/bus.js";
import { deriveActivity } from "../agent/derive-activity.js";
import type { ToolSpec } from "../agent/tool-specs.js";

export const MEMEX_AGENT_INSTRUCTIONS = `# Memex MCP — orient before you act

Memex hosts **Specs** (living docs of purpose, decisions, tasks), scoped to a **Memex** (workspace).

## Where the depth lives

This orientation is intentionally tiny. Operating depth (phase mechanics, AC emission, decisions-vs-tasks, stuck/escalation, rule-overrides) lives in **\`get_information\`** — call with no args for the topic index, or with \`topic='<slug>'\` for one topic's body. Fetch the relevant topic before acting on a concept this orientation doesn't spell out.

## First moves

1. **Pick a Memex.** \`list_memexes()\` and show the list before any scoped mutation. Don't auto-pick or default to personal. Pass \`memex=<namespace>/<memex>\` to scoped tools.
2. **Orient.** \`list_docs()\` / \`get_doc(handle)\` before mutating. \`list_docs()\` shows ACTIVE Specs only.
3. **Before every forward phase move:** call \`assess_spec({mode:'phase', target:<phase>})\` and walk its rubric against the facts. Surface the verdict to the user.
4. **Ground decisions in code.** Read the source a code-touching decision names before resolving it — don't lean on CLAUDE.md or prior knowledge.

## Two non-negotiable rules

1. **Tasks only in \`build\`.** A task in draft/specify is a guess pretending to be a commitment. Resolve decisions first.
2. **\`complete\` only when verification actually runs** — tests + type checks + exercising the path, not vibes. Closing a Spec (\`done\`) is the user's call, never the agent's.

## Pipeline

Five phases: \`draft → specify → build → verify → done\`, plus orthogonal \`paused\`/\`archived\` flags. Tool responses are terse by default; pass \`verbose: true\` for full markdown. Call \`get_information(topic='phases')\` for the full phase mechanics including \`assess_spec\` modes.`;

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// Last-resort handler — Anthropic Connectors Directory (b-31 W4) requires
// unknown errors to surface a structured message with a request ID so users
// can ask support to look up the underlying failure, instead of a generic
// "Internal Server Error". The actual error is logged server-side; the
// response carries only the request ID (no stack, no DB text).
// Exported for unit testing — the createMcpServer path is integration-only.
export function handleError(err: unknown) {
  if (err instanceof McpAuthError) return errorResult(err.message);
  if (err instanceof NotFoundError) return errorResult(`Not found: ${err.message}`);
  if (err instanceof ValidationError) return errorResult(`Validation error: ${err.message}`);
  const requestId = randomUUID();
  // Log to stderr so Cloud Run picks it up — the only place the real error
  // lives. Includes the request ID so a support request can correlate.
  console.error(`[MCP unexpected error] request=${requestId}`, err);
  return errorResult(
    `Unexpected server error; please report — request ID ${requestId}`,
  );
}

/**
 * spec-156 ac-15: emit a read/advisory Pulse activity for a NON-mutating MCP
 * tool invocation. This is the MCP analog of `emitInAppAgentActivity`
 * (services/conversations.ts) — same shared `deriveActivity` mapping, but the
 * event carries `channel: "mcp"`. Mutating tools already emit through mutate()
 * inside their service handlers, so `deriveActivity` returns null for them and
 * we stay silent (no double-emit).
 *
 * Fully advisory: it is called only after the tool's `fn` has RESOLVED (a
 * failed call emits nothing), and is wrapped so a derivation/emit bug can never
 * perturb the tool result. The MCP surface has no doc-bound conversation, so
 * `docId`/`clientId` stay undefined (unlike the in-app path).
 */
export function emitMcpActivity(
  spec: ToolSpec,
  memexId: string | undefined,
  userId: string,
  input: Record<string, unknown>,
): void {
  try {
    const activity = deriveActivity(spec, spec.name, input);
    if (!activity) return;
    // Activity is keyed to a Memex; without a resolved memexId there is no
    // tenancy to attribute it to, so we stay silent.
    if (!memexId) return;
    bus.emit({
      memexId,
      userId,
      entity: activity.entity,
      action: activity.action,
      narrative: activity.narrative,
      channel: "mcp",
      payload: activity.payload,
    });
  } catch {
    // No-op — activity emission is never on the tool's critical path.
  }
}

/**
 * b-31 dec-8: filter a user's full membership list down to what the OAuth
 * token covers. PAT callers pass `undefined` and get every membership back
 * (no regression). Exported for unit testing — the rule is small but a
 * silent break would invisibly leak cross-Org memexes to a scoped token.
 */
export function filterMembershipsForOrgScope<
  T extends { kind: "personal" | "team"; orgId?: string | null }
>(memberships: T[], orgFilter: string | null | undefined): T[] {
  if (orgFilter === undefined) return memberships; // PAT — full surface
  return memberships.filter((m) => {
    if (m.kind === "personal") return true; // personal always granted
    if (orgFilter === null) return false; // personal-only token
    return m.orgId === orgFilter; // org-scoped token
  });
}

async function workspaceUrl(memexId: string): Promise<string> {
  // Build the canonical path-based tenant URL: `${host}/<namespace>/<memex>`.
  // Formatters append `/briefs/<handle>` etc. on top. Per [std-2] tenant
  // routing is path-based; no subdomain prefixing.
  const slugs = await memexSlugsById(memexId);
  return slugs ? buildTenantUrl(slugs) : "";
}

/**
 * Create a fresh MCP server instance bound to a single user.
 *
 * `orgFilter` (b-31 dec-8):
 *   - `undefined` → PAT (`mxt_`) caller. No Org-scope filter applied; full
 *     user surface visible. Asserted by a regression test — must remain
 *     undefined for PAT callers.
 *   - `null` → OAuth caller for a personal-only grant.
 *   - `<orgId>` → OAuth caller for the chosen Org.
 *
 * The filter shapes:
 *   - `list_memexes` output (filtered to in-scope memexes).
 *   - Every resolveWorkspace / resolveMemexFromEntity call (memex must be
 *     in-scope; otherwise the standard "not a member" error fires).
 *
 * `sessionId` (mcp telemetry):
 *   - `undefined` → no telemetry rows written (tests, ad-hoc uses).
 *   - `<sessionId>` → every tool call writes one mcp_tool_calls row under
 *     this session. Required by the /mcp request handler; supplied from
 *     the Mcp-Session-Id header (or the server-minted UUID).
 */
export function createMcpServer(
  userId: string,
  orgFilter?: string | null,
  sessionId?: string,
): McpServer {
  const server = new McpServer(
    { name: "memex", version: "0.4.0" },
    { instructions: MEMEX_AGENT_INSTRUCTIONS },
  );

  // Telemetry wrap shared by every tool registered below (including the
  // MCP-only list_memexes and every shared-catalogue spec). Captures
  // duration + outcome and writes one mcp_tool_calls row per invocation.
  // Logging is error-swallowing inside logToolCall — telemetry NEVER
  // breaks the tool path. Skipped when sessionId is undefined (tests).
  //
  // Error capture (b-mcp-telemetry follow-up): the wrap OWNS both telemetry
  // and the agent-facing error envelope. `fn` simply returns a string on
  // success or throws on failure — the wrap calls handleError to produce the
  // redacted, agent-safe response, AND captures the FULL original error
  // (name + message + stack) into the mcp_tool_calls.error column. This way
  // the telemetry row has enough information to debug a failure without
  // hunting through Cloud Run logs by request-id correlation; the agent
  // still sees only the redacted message.
  //
  // `getMemexId` is supplied by the caller — for shared-catalogue specs it
  // reads a closure variable that the ctx resolvers write into (resolveMemex
  // / resolveRef / resolveMemexFromEntity). For MCP-only tools that don't
  // resolve a memex (list_memexes), the caller passes `undefined` and the
  // row is written with memex_id NULL.
  type TelemetryFn<I> = (input: I) => Promise<string>;
  type WrappedFn<I> = (input: I) => Promise<{
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
  }>;
  const formatErrorForTelemetry = (err: unknown): string => {
    if (err instanceof Error) {
      const head = `${err.name}: ${err.message}`;
      // Stack includes the head line in V8; if present, prefer the stack so
      // we get the call site that produced the error (this is the whole
      // point of capturing it richer than handleError redacts).
      return err.stack ?? head;
    }
    return String(err);
  };
  const withTelemetry = <I>(
    toolName: string,
    fn: TelemetryFn<I>,
    getMemexId?: () => string | undefined,
    // spec-156 ac-15: the catalogue spec backing this tool. When supplied, the
    // wrap emits a read/advisory bus event (channel 'mcp') on SUCCESS for every
    // non-mutating tool — the single MCP site that completes std-8's spec-60
    // "one site per channel" amendment. Omitted for MCP-only tools with no spec
    // (list_memexes), which carry no catalogue activity mapping.
    activitySpec?: ToolSpec,
  ): WrappedFn<I> => {
    return async (input: I) => {
      const started = Date.now();
      let resultText: string | undefined;
      let errorMessage: string | undefined;
      try {
        const text = await fn(input);
        resultText = text;
        // Emit AFTER a successful call only (a failed/throwing tool emits no
        // activity). Advisory + non-throwing — see emitMcpActivity.
        if (activitySpec) {
          emitMcpActivity(
            activitySpec,
            getMemexId?.(),
            userId,
            input as Record<string, unknown>,
          );
        }
        return textResult(text);
      } catch (err) {
        // Capture the FULL error for telemetry BEFORE handleError redacts.
        errorMessage = formatErrorForTelemetry(err);
        return handleError(err);
      } finally {
        if (sessionId) {
          void logToolCall({
            sessionId,
            userId,
            memexId: getMemexId?.() ?? null,
            toolName,
            args: input as unknown,
            durationMs: Date.now() - started,
            error: errorMessage ?? null,
            resultText: resultText ?? null,
          });
        }
      }
    };
  };

  // ── MCP-only: Memex discovery ──────────────────────────────
  server.tool(
    "list_memexes",
    "List the Memexes this user is a member of, grouped by namespace. Identifiers come back in `<namespace>/<memex>` form (e.g. `mindset/website-rewrite`) — the same string scoped tools expect as their `memex` argument. Each entry carries `kind` (personal or team). Call this at the START of any session and present the list to the user as a chooser before any scoped mutation — do not auto-pick the only / personal one.",
    {},
    { title: "List Memexes", readOnlyHint: true, destructiveHint: false },
    withTelemetry("list_memexes", async () => {
      const memberships = await listMemberships(userId);
      const filtered = filterMembershipsForOrgScope(memberships, orgFilter);
      // Piggy-back the guidance topic index on this orient call so the
      // topic names land in the agent's context during normal
      // orientation, raising the prior on the agent calling
      // get_information(topic) at activation moments later. If the
      // guidance directory is missing or unreadable for any reason,
      // fall through silently — the orient call still succeeds.
      // withTelemetry handles error wrapping; the inner try here only
      // swallows the best-effort appendix.
      let topics: Awaited<ReturnType<typeof listTopics>> = [];
      try {
        topics = await listTopics();
      } catch {
        // intentionally swallowed — appendix is best-effort
      }
      return formatMemexList(filtered, topics);
    }),
  );

  // ── Shared catalogue (30 tools) ────────────────────────────
  // Each spec gets the same ctx: full membership-resolving auth helpers.
  // The OAuth Org-scope (b-31 dec-8) is carried via closure into every
  // resolve call so the membership check applies the same filter.
  // Per dec-1 of doc-20 the default response shape is TERSE — the call
  // input carries the optional `verbose` flag (see VERBOSE_FIELD in
  // tool-specs.ts) that opts in to the full markdown surface. The flip
  // here means the MCP surface no longer overflows the agent's tool-result
  // budget on a large doc; the agent can still pass `verbose: true` on the
  // rare occasion it wants the full state right after a mutation.
  // handleError flattens domain errors to MCP error results and lets
  // unknown errors bubble (the MCP transport will turn those into a
  // JSON-RPC error response).
  //
  // b-33 t-5: per-phase description overrides are read from
  // `agent/phases/<phase>/mcp-descriptions.md`. The merge mechanism is in
  // place; today we pass `phase: undefined` (passthrough) because the MCP
  // server is constructed per-request in app.ts without a resolved Spec —
  // the agent picks a spec inside a tool call, not at server init. The
  // stub files are currently comment-only, so even when phase-awareness
  // lands the behaviour is unchanged until someone adds an override. See
  // `mcp/phase-descriptions.ts` for the format and merge semantics.
  // TODO(phase-aware-mcp): plumb the per-request Spec phase down to here
  // and pass it instead of `undefined`.
  const resolvedSpecs = applyPhaseDescriptionOverrides(toolSpecs, undefined);
  for (const spec of resolvedSpecs) {
    // Per-call closure: each ctx resolver records the memexId it resolved
    // into this variable, and the telemetry wrap reads it in its finally
    // block to stamp memex_id on the mcp_tool_calls row. Safe under
    // concurrency because createMcpServer is constructed per-request — the
    // closure scope belongs to one tool invocation.
    let resolvedMemexId: string | undefined;
    // spec-111 t-4: every read entrypoint reports whether the caller has write
    // access to the resolved memex. Once any resolver fires we know the gate;
    // `enforceWriteGate` rejects a write tool (readOnlyHint === false) the
    // moment a non-member (readOnly === true) has resolved a public memex.
    // Reads (readOnlyHint === true) pass through for any canReadMemex caller,
    // including anonymous on public memexes.
    const enforceWriteGate = (readOnly: boolean) => {
      if (readOnly && !spec.annotations.readOnlyHint) {
        throw new McpAuthError(READ_ONLY_PUBLIC_MESSAGE);
      }
    };
    const handler = withTelemetry(
      spec.name,
      async (input: Record<string, unknown>) => {
        const ctx: ToolCtx = {
          userId,
          // spec-203 Layer 2 (dec-2): thread the dispatch-layer session id into
          // ctx so the centralized footer machine can key its once-per-(user,
          // session, spec, phase) full-handoff delivery on it. Undefined in
          // stateless/test paths (createMcpServer's sessionId param), which is
          // exactly when the footer falls back to the compressed essence.
          sessionId,
          // spec-156 ac-19: this is the MCP surface. Handlers that derive a
          // mutate() channel from ctx (update_doc's tag writes) read this so
          // Pulse attributes MCP-driven activity to the `mcp` channel.
          channel: "mcp",
          resolveMemex: async (memex) => {
            const { memexId, readOnly } = await resolveWorkspaceForRead(
              userId,
              memex,
              orgFilter,
            );
            resolvedMemexId = memexId;
            enforceWriteGate(readOnly);
            // spec-199 t-14: Cloud SQL postgres lacks BYPASSRLS, so FORCE ROW
            // LEVEL SECURITY on tenant tables applies to every role. Set the
            // ALS context so all subsequent DB calls in this handler execution
            // have app.memex_id injected by the rlsClient proxy.
            memexContext.enterWith({ memexId });
            return memexId;
          },
          resolveMemexFromEntity: async (kind, id) => {
            const { memexId, readOnly } = await resolveMemexFromEntityForRead(
              userId,
              kind,
              id,
              orgFilter,
            );
            resolvedMemexId = memexId;
            enforceWriteGate(readOnly);
            memexContext.enterWith({ memexId });
            return memexId;
          },
          resolveRef: async (ref) => {
            const result = await resolveRefForUser(userId, ref, orgFilter);
            resolvedMemexId = result.memexId;
            enforceWriteGate(result.readOnly);
            memexContext.enterWith({ memexId: result.memexId });
            return result;
          },
          workspaceUrl,
          verbose: input.verbose === true,
          // b-68 t-8 / ac-29: same nudge-channel plumbing as the React
          // surface. `toolName` is the spec name dispatching this handler;
          // `getOrgBlocksForNudge` resolves the principal's Org-overlay
          // blocks at call time (after the ctx resolvers have populated
          // `resolvedMemexId`). Both surfaces composing nudge text via this
          // identical pair is the load-bearing parity guarantee.
          toolName: spec.name,
          getOrgBlocksForNudge: buildNudgeOrgBlocksGetter(
            () => resolvedMemexId,
          ),
        };
        // Throw on error — withTelemetry catches, captures the FULL error
        // (name + message + stack) into mcp_tool_calls.error, then calls
        // handleError to produce the redacted agent-facing envelope.
        //
        // spec-189: handler execution goes through the channel-neutral
        // traffic seam — after a SUCCESSFUL call, the Spec the call resolved
        // to may auto-advance phase and auto-assign the caller (see
        // services/spec-traffic.ts). Identical wiring on the in-app agent
        // surface (agent/tools.ts → executeServerTool) per dec-5.
        return await runToolWithSpecTraffic(spec, input, ctx);
      },
      () => resolvedMemexId,
      // spec-156 ac-15: pass the spec so the wrap emits a 'mcp'-channel
      // read/advisory bus event for non-mutating tools on success.
      spec,
    );
    server.tool(spec.name, spec.description, spec.schema, spec.annotations, handler);
  }

  return server;
}

// b-36 T-6: shared ref-resolution path for MCP-side tool calls.
//
// Steps:
//   1. Parse the ref string (so we can recover the namespace/memex slugs
//      without an extra DB hop after the resolver returns).
//   2. Run the canonical resolver. `redirected` propagates as an error
//      message — the resolver caller is expected to retry with newRef.
//   3. Apply the spec-111 read gate on the resolved entity's owning memex and
//      surface the `readOnly` write flag.
//   4. Compose ResolvedRef for the spec.
// Exported for the resolve-ref-org-scope regression test — verifies that the
// orgFilter passes through to the membership check so OAuth tokens scoped to
// Org A can't reach Org B's entities by canonical ref.
//
// spec-111 t-4: returns ResolvedRef extended with `readOnly`. The dispatch
// wrapper reads it to gate write tools; the value is stripped back to a plain
// ResolvedRef before it reaches the spec handler (which never sees readOnly).
export async function resolveRefForUser(
  userId: string,
  ref: string,
  orgFilter?: string | null,
): Promise<ResolvedRef & { readOnly: boolean }> {
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
  // spec-178 t-11 / dec-11 (ac-37): a handhold demo spec is inert to the MCP
  // surface — a coding agent must not be able to read it (get_doc/export_doc)
  // or mutate against it (update_doc, add_section, decision/task writes, …),
  // and every one of those tools resolves its target ref through here. Treat a
  // demo doc as not-found (std-7: missing, not forbidden) so the agent gets the
  // same answer as for a ref that doesn't exist. The board's REST getDoc path
  // is untouched — it never goes through resolveRefForUser.
  if (doc.isDemo) {
    throw new NotFoundError(`Ref "${ref}" not found.`);
  }
  const memexId = doc.memexId;
  // orgFilter (b-31 dec-8) — undefined for PAT (skip), null for personal-only
  // OAuth, <orgId> for Org-scoped OAuth. The read gate enforces it (a private
  // memex outside the OAuth scope falls through to the membership check and
  // surfaces the std-7 "not found" error). `readOnly` is true for a non-member
  // on a public memex.
  const { readOnly } = await assertReadAccessForMemex(
    userId,
    memexId,
    undefined,
    orgFilter,
  );

  // Slugs come from the parsed ref itself — no DB lookup needed for the
  // common case. memexSlugsById is the fallback for callers that build a
  // ResolvedRef from outside the parse path.
  const slugs = { namespace: parsed.ref.namespace, memex: parsed.ref.memex };
  return { entity, memexId, doc, slugs, readOnly };
}

// Suppress unused-import warning — `memexSlugsById` is part of the public
// helper surface, exercised in tests.
void memexSlugsById;
