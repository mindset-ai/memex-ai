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
// Verify-class traffic has no MCP tool today: it arrives as CI test_events
// via POST /api/test-events, which calls `observeTestEventTraffic` below
// (transition only — an emission key carries no acting user, so there is
// nothing to assign).
//
// Failure posture: observation is best-effort and MUST NEVER fail or delay
// the user's tool call semantics — every entry point catches everything and
// logs to stdout.

import { and, eq } from "drizzle-orm";
import {
  nextPhaseForTraffic,
  toolManifest,
  type ToolManifestEntry,
} from "@memex/shared";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { FOOTER_DELIMITER } from "../mcp/footer-delimiter.js";
import { isSpecStatus } from "../types/roles.js";
import { assign } from "./doc-assignees.js";
import { promoteToEditor } from "./doc-members.js";
import { updateDocStatus } from "./documents.js";
// Type-only imports — erased at compile time, so no runtime cycle with
// agent/tool-specs.ts (which imports this module's consumers).
import type { ToolCtx } from "../agent/tool-specs.js";

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

    // ── Auto-assignment + editor role (dec-6) ─────────────────────────
    if (entry.autoAssignExempt !== true) {
      try {
        await assign(event.memexId, event.docId, event.userId, event.userId);
        await promoteToEditor(event.memexId, event.docId, event.userId);
      } catch (err) {
        console.warn(
          `[spec-traffic] auto-assign failed for ${event.toolName} on ${doc.handle}:`,
          err,
        );
      }
    }

    // ── Phase advancement ─────────────────────────────────────────────
    // paused/archived are deliberate placements — auto-advance must not
    // fight them (same principle as dec-5's rest_ui exclusion). Traffic
    // never unflags; it also doesn't shuffle the phase underneath a flag.
    if (entry.trafficClass === null) return;
    if (doc.pausedAt !== null || doc.archivedAt !== null) return;
    if (!isSpecStatus(doc.status)) return;

    const next = nextPhaseForTraffic(doc.status, entry.trafficClass);
    if (next === doc.status) return;

    await updateDocStatus(event.memexId, event.docId, next, {
      ctx: { channel: event.channel },
      narrative: `auto-advanced ${doc.handle} ${doc.status} → ${next} (agent activity via ${event.toolName})`,
    });
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
  const wrappedCtx: ToolCtx = {
    ...ctx,
    resolveRef: async (ref) => {
      const result = await ctx.resolveRef(ref);
      target = { memexId: result.memexId, docId: result.doc.id };
      return result;
    },
  };
  const text = await spec.handler(input, wrappedCtx);
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

  // spec-203 ac-14/ac-15: the ONE place a footer is attached. Every tool call is
  // the client phoning home; here — and only here — the single seat
  // (`decideFooter`) takes that opening to steer the client, on EVERY
  // Spec-resolving response (terse and verbose), never per-tool and never twice.
  // The seat frames its return with FOOTER_DELIMITER, so the telemetry wrap that
  // runs after this splits + persists it (ac-17). Guards: only when the call
  // resolved ONE Spec (`target` set — list/search resolve none), and only when
  // the body does not already carry a footer (defence-in-depth; the body no
  // longer composes one). `decideFooter` is imported dynamically to keep this
  // module free of a runtime cycle with agent/tool-specs.ts (cached after first
  // use); it never throws, but the guard keeps a footer failure off the result.
  if (target && !text.includes(FOOTER_DELIMITER)) {
    try {
      const { decideFooter } = await import("../agent/tool-specs.js");
      const footer = await decideFooter(target.memexId, target.docId, ctx);
      if (footer) return `${text}\n\n${footer}`;
    } catch {
      // swallow — the tool's real result already succeeded.
    }
  }
  return text;
}

/**
 * Verify-class traffic from CI: a test_event arriving for an AC is evidence
 * of verification activity on the AC's Spec (dec-1). Transition only — the
 * emission key authenticates a Memex, not a user, so there is no caller to
 * assign. Hidden emissions are excluded: `hidden: true` exists precisely to
 * keep an emission out of the visible signals (e.g. iterating on a
 * done-phase regression fix must not reopen the Spec). Never throws.
 */
export async function observeTestEventTraffic(
  memexId: string,
  acUid: string,
): Promise<void> {
  try {
    // ac_uid grammar: <namespace>/<memex>/specs/<spec-handle>/acs/<ac-handle>
    const match = /\/specs\/([^/]+)\/acs\//.exec(acUid);
    const specHandle = match?.[1];
    if (!specHandle) return;

    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.memexId, memexId),
        eq(documents.handle, specHandle),
      ),
    });
    if (!doc || doc.docType !== "spec" || doc.isDemo) return;
    if (doc.pausedAt !== null || doc.archivedAt !== null) return;
    if (!isSpecStatus(doc.status)) return;

    const next = nextPhaseForTraffic(doc.status, "verify");
    if (next === doc.status) return;

    await updateDocStatus(memexId, doc.id, next, {
      ctx: { channel: "server" },
      narrative: `auto-advanced ${doc.handle} ${doc.status} → ${next} (test event for ${acUid.split("/").pop()})`,
    });
  } catch (err) {
    console.warn("[spec-traffic] test-event observation failed:", err);
  }
}
