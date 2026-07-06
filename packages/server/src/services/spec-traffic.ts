// spec-189: traffic-driven phase advancement + auto-assignment.
//
// Agent tool traffic (channels 'mcp' and 'in_app_agent' — dec-5; never
// 'rest_ui', where the human is present with full phase controls) is observed
// AFTER each successful tool call and drives two automatic behaviours:
//
//   1. Phase advancement — the tool's `trafficClass` from the @memex/shared
//      manifest (dec-4, the single classification source) feeds the pure
//      transition function `nextPhaseForTraffic` (spec-readiness.ts, the
//      single place the matrix lives — ac-3). A resulting change applies
//      through `updateDocStatus()` → mutate() → bus, so the Kanban board
//      updates live (std-8).
//   2. Auto-assignment + editor role — any mutating, non-exempt call assigns
//      the calling user to the Spec AND idempotently promotes them to editor
//      (dec-6: someone actively mutating a Spec through an agent is
//      functionally an editor already). This deliberately supersedes
//      spec-118 dec-3's role/assignment independence for the TRAFFIC-DRIVEN
//      path only; manual assign_spec / unassign_spec / set_spec_role keep
//      their role-independent semantics (they're `autoAssignExempt` in the
//      manifest precisely so auto-assignment can't fight them —
//      unassign_spec(self) must not instantly undo itself).
//
// spec-342: test emission events NO LONGER drive phase. A Spec's phase is a
// deliberate human / handoff placement; CI test_events (POST /api/test-events)
// update AC verdicts and the audit trail only. The former build→verify (and
// done→verify reopen) auto-promote — `observeTestEventTraffic` — was removed
// here, completing the arc spec-327 began: traffic is not a phase intent.
//
// Failure posture: observation is best-effort and MUST NEVER fail or delay
// the user's tool call semantics — every entry point catches everything and
// logs to stdout.

import { and, eq } from "drizzle-orm";
import {
  toolManifest,
  type ToolManifestEntry,
} from "@memex/shared";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { FOOTER_DELIMITER } from "../mcp/footer-delimiter.js";
import { assign } from "./doc-assignees.js";
import { promoteToEditor } from "./doc-members.js";
import { markPresent } from "./presence.js";
import { enforceCheckoutGate } from "./checkout-gate.js";
import { enforcePhaseGate } from "./phase-gate.js";
// Type-only imports — erased at compile time, so no runtime cycle with
// agent/tool-specs.ts (which imports this module's consumers).
import type { ToolCtx, FooterSlot } from "../agent/tool-specs.js";

// One lookup table, built once from the single-source manifest (dec-4).
const manifestByName: ReadonlyMap<string, ToolManifestEntry> = new Map(
  toolManifest.map((e) => [e.name, e]),
);

export interface SpecTrafficEvent {
  toolName: string;
  /** The surface the call came from. Only 'mcp' / 'in_app_agent' act (dec-5). */
  channel: "mcp" | "in_app_agent";
  /** The authenticated caller — the user behind the MCP token / in-app session. */
  userId: string;
  /** The Spec the call resolved to. Absent → the call targeted no Spec; no-op. */
  memexId?: string;
  docId?: string;
}

/**
 * Observe one successful agent tool call. Never throws.
 *
 * Order of effects: assignment+role first (they apply to ANY mutating,
 * non-exempt call), then the phase transition (only for classified traffic).
 * Each is independently guarded so one failing cannot suppress the other.
 */
export async function observeSpecTraffic(event: SpecTrafficEvent): Promise<void> {
  try {
    const entry = manifestByName.get(event.toolName);
    // Unknown tool (MCP-only extras like list_memexes never resolve a Spec
    // anyway) or read-only → query-class: never moves a Spec, never assigns.
    if (!entry || entry.readOnlyHint) return;
    if (event.channel !== "mcp" && event.channel !== "in_app_agent") return;
    if (!event.memexId || !event.docId) return;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, event.docId),
        eq(documents.memexId, event.memexId),
      ),
    });
    // Only Specs have a lifecycle to advance / an assignment surface; demo
    // Specs are inert to the whole agent surface (spec-178).
    if (!doc || doc.docType !== "spec" || doc.isDemo) return;

    // ── Presence heartbeat (spec-255) ─────────────────────────────────
    // Every agent tool call that touches a Spec marks the ACTOR present, so
    // Pulse's "active now" reflects in-app agents too. The telemetry floor only
    // sees the MCP surface (mcp_tool_calls); without this an in_app_agent
    // conversation is invisible to presence (active-now showed 0 while a human
    // was actively conversing). Silent / out-of-band (std-8), like the browser
    // heartbeat. actorKind follows the surface; the human owns the row.
    try {
      await markPresent({
        memexId: event.memexId,
        docId: event.docId,
        actorUserId: event.userId,
        actorKind: event.channel === "in_app_agent" ? "in_app_agent" : "mcp_agent",
        channel: event.channel,
        clientId: event.channel,
      });
    } catch (err) {
      console.warn("[spec-traffic] presence heartbeat failed:", err);
    }

    // ── Auto-assignment + editor role (dec-6) ─────────────────────────
    if (entry.autoAssignExempt !== true) {
      try {
        // spec-122 dec-5: attribute the traffic-driven assign/promote to the
        // human who made the triggering call, on the surface it came in on
        // (mcp / in_app_agent — guarded above) so Pulse shows them, not "System".
        const trafficCtx = { actorUserId: event.userId, channel: event.channel };
        await assign(event.memexId, event.docId, event.userId, event.userId, trafficCtx);
        await promoteToEditor(event.memexId, event.docId, event.userId, trafficCtx);
      } catch (err) {
        console.warn(
          `[spec-traffic] auto-assign failed for ${event.toolName} on ${doc.handle}:`,
          err,
        );
      }
    }

    // ── Phase advancement: REMOVED (spec-464 dec-1) ───────────────────
    // Traffic-driven auto-advancement (spec-189) is gone. A Spec's phase now
    // changes ONLY via an explicit publish_spec/update_doc call or a human
    // web-UI move — no tool call moves a Spec as a side effect. This was the
    // "nobody moved it" complaint (Petya spec-4, Jonathan spec-172, ViperPro
    // spec-13) and it completes the arc spec-327/342/295 began. Presence +
    // auto-assign above STAY (separate behaviours, not the complaint).
    //
    // Ahead-of-phase agent calls are now REFUSED at the tool seam
    // (runToolWithSpecTraffic → enforcePhaseGate, spec-464 dec-2) rather than
    // silently advancing the phase; `homePhase` on the manifest drives that.
  } catch (err) {
    // Observation is advisory — never break or fail the tool call.
    console.warn("[spec-traffic] observation failed:", err);
  }
}

/**
 * The channel-neutral seam (dec-5): BOTH tool surfaces — the MCP wrap
 * (mcp/tools.ts) and the in-app agent loop (agent/tools.ts →
 * executeServerTool) — execute their tool handlers through this one
 * function, so traffic observation has exactly one implementation.
 *
 * The wrapped ctx records the Spec each `resolveRef` lands on (every
 * doc-targeting tool resolves its ref through ctx.resolveRef); after the
 * handler SUCCEEDS, the observation runs. A throwing handler observes
 * nothing — failed calls are not traffic.
 */
export async function runToolWithSpecTraffic(
  spec: {
    name: string;
    handler: (input: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
  },
  input: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  let target: { memexId: string; docId: string } | undefined;
  // spec-219 dec-3 (t-3): the shared footer slot. A handler parks its dynamic
  // footer nugget here; the seat (`composeGuidanceEnvelope`) reads it back and
  // folds it into the footer, so it lands AFTER the delimiter and is persisted.
  // One holder, threaded into the handler's ctx AND handed to the seat below.
  const footerSlot: FooterSlot = {};
  const wrappedCtx: ToolCtx = {
    ...ctx,
    footerSlot,
    resolveRef: async (ref) => {
      const result = await ctx.resolveRef(ref);
      target = { memexId: result.memexId, docId: result.doc.id };
      return result;
    },
    // spec-219 Phase 2: a creating tool resolves no ref, so capture the doc it
    // made here — this is what lets composeGuidanceEnvelope run for create_doc.
    recordCreatedDoc: (memexId, docId) => {
      target = { memexId, docId };
    },
  };
  // spec-371 (dec-11): enforce the checkout gate BEFORE the handler writes. A
  // recent-colleague collision throws the agent-actionable takeover error here, so
  // the mutation never runs; otherwise this stamps the implicit checkout/refresh.
  await enforceCheckoutGate(spec.name, input, ctx);
  // spec-464 dec-2: refuse an ahead-of-phase agent call BEFORE the handler
  // writes (enforcePhaseGate throws the teaching refusal), or capture an
  // advisory/nudge note to fold into the response for allowed-but-off-home
  // calls (draft planning nudge dec-3/5; behind-phase advisory dec-21). The
  // human web UI (rest_ui) is exempt inside the gate.
  const phaseNote = await enforcePhaseGate(spec.name, input, ctx);
  const handlerText = await spec.handler(input, wrappedCtx);
  const text = phaseNote ? `${phaseNote}\n\n${handlerText}` : handlerText;
  // Awaited (not detached) so the effects are deterministic for callers and
  // tests; observeSpecTraffic never throws.
  await observeSpecTraffic({
    toolName: spec.name,
    // ToolCtx.channel defaults to 'mcp' at the call sites that omit it —
    // mirror that here (see ToolCtx.channel docs in tool-specs.ts).
    channel: ctx.channel ?? "mcp",
    userId: ctx.userId,
    ...target,
  });

  // spec-203 ac-14/ac-15 + spec-219 ac-6/ac-7: the ONE place the platform
  // guidance ENVELOPE is attached. Every tool call is the client phoning home;
  // here — and only here — the single seat (`composeGuidanceEnvelope`) takes that
  // opening to steer the client, on EVERY Spec-resolving response (terse and
  // verbose), never per-tool and never twice. The seat returns DELIMITER-LESS
  // `{ header?, footer? }`; this choke point assembles
  // `header + body + FOOTER_DELIMITER + footer` — header prepended above the
  // body, the single FOOTER_DELIMITER owned HERE (written exactly once), footer
  // after it — so the telemetry wrap that runs after this splits + persists the
  // footer (ac-17). Guards: only when the call resolved ONE Spec (`target` set —
  // list/search resolve none), and only when the body does not already carry a
  // footer (defence-in-depth; the body composes none). `composeGuidanceEnvelope`
  // is imported dynamically to keep this module free of a runtime cycle with
  // agent/tool-specs.ts (cached after first use); it never throws, but the guard
  // keeps a guidance failure off the result.
  if (target && !text.includes(FOOTER_DELIMITER)) {
    try {
      const { composeGuidanceEnvelope } = await import("../agent/tool-specs.js");
      // Pass wrappedCtx — it carries the footerSlot the handler may have parked.
      const { header, footer } = await composeGuidanceEnvelope(
        target.memexId,
        target.docId,
        wrappedCtx,
      );
      let out = text;
      if (header) out = `${header}${out}`;
      if (footer) out = `${out}\n\n${FOOTER_DELIMITER}\n${footer}`;
      return out;
    } catch {
      // swallow — the tool's real result already succeeded.
    }
  }
  return text;
}

// spec-342: `observeTestEventTraffic` was removed here. A CI test_event used to
// auto-advance its AC's Spec build→verify (and reopen a done Spec to verify);
// it no longer does — test events update the AC verdict + audit trail only, and
// phase is a deliberate human placement. POST /api/test-events therefore makes
// no phase change. The verdict path (applyEmissionToSummary, analytics) is
// untouched and is the sole remaining reader of the `hidden` flag.
