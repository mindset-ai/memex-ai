// spec-371 rework — the checkout-enforcement GATE (dec-11). It sits at the single
// tool-dispatch seam (services/spec-traffic.ts runToolWithSpecTraffic), so EVERY
// spec-mutating tool call — MCP or in-app agent — passes through it BEFORE the
// handler writes.
//
// On a spec mutation by user U:
//   free / held by U / last held by another user beyond the window
//        → IMPLICIT checkout-or-refresh, then proceed (the developer is never
//          asked to claim first — no nudge, ac-5/ac-20).
//   held by ANOTHER user WITHIN the window
//        → throw an AGENT-ACTIONABLE takeover error (who + how-long-ago + the
//          exact claim_spec call to retry). Nothing is hard-blocked: explicit
//          claim_spec is not gated and always takes over (ac-7/ac-22).

import { ValidationError } from "../types/errors.js";
import {
  getCheckout,
  collisionAgainst,
  stampCheckout,
  describeCollision,
} from "./checkout.js";
import type { ToolCtx } from "../agent/handlers/shared.js";

// The spec-mutating tools subject to the gate. The checkout VERBS themselves
// (claim_spec / unclaim_spec) are deliberately ABSENT — explicit checkout is never
// gated (ac-22). create_doc is absent — making a new doc isn't editing a spec.
//
// `set_sensitive` is ABSENT ON PURPOSE too (spec-535 dec-6) — do not "fix" this by
// adding it. The gate throws a takeover error when another user has held the Spec
// for less than the collision window; applied to that tool it would mean an agent
// that notices a Spec is dangerous WHILE a colleague is working it must seize that
// colleague's checkout in order to post the warning about them. The mechanism built
// to stop people stepping on each other would require stepping on someone to use,
// and it would fail at exactly the moment the warning is worth most.
//
// It belongs with claim_spec / unclaim_spec above for the same structural reason:
// it is a meta-operation about the work (is this dangerous, who to ask), not an
// edit OF the work. It changes no Spec content, it is idempotent, and anyone with
// write access can reverse it.
export const GATED_SPEC_TOOLS = new Set<string>([
  "update_doc", // phase move + title/tags
  "update_section",
  "add_section",
  "retitle_section",
  "delete_section",
  "create_decision",
  "update_decision",
  "resolve_decision",
  "delete_decision",
  "approve_candidate",
  "reject_candidate",
  "add_clause",
  "edit_clause",
  "delete_clause",
  "create_task",
  "update_task",
  "delete_task",
  "create_ac",
  "update_ac",
  "delete_ac",
  "link_ac_to_decision",
  "write_qa_report",
  "ground_spec",
]);

/**
 * Enforce the checkout gate for a spec-mutating tool call, BEFORE its handler
 * writes (dec-11). A no-op for non-gated tools, refs that don't resolve, and
 * non-spec docs. Throws a ValidationError (surfaced to the agent verbatim) on a
 * recent-colleague collision; otherwise stamps the implicit checkout/refresh.
 */
export async function enforceCheckoutGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolCtx,
  now: number = Date.now(),
): Promise<void> {
  if (!GATED_SPEC_TOOLS.has(toolName)) return;
  const ref = input.ref;
  if (typeof ref !== "string" || ref.length === 0) return;

  let resolved;
  try {
    resolved = await ctx.resolveRef(ref);
  } catch {
    return; // unresolvable → let the handler raise its own clean error
  }
  if (resolved.doc.docType !== "spec") return; // only specs are gated

  const docId = resolved.doc.id;
  const collision = collisionAgainst(await getCheckout(docId), ctx.userId, now);
  if (collision) {
    const { holderName, minutesAgo } = await describeCollision(collision);
    throw new ValidationError(
      `${holderName} checked this spec out ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago. ` +
        `Ask the user whether to take it over; if they confirm, call claim_spec({ ref: "${ref}" }) ` +
        `and retry this edit. (Memex never blocks — claiming always succeeds; this is just so you ` +
        `don't unknowingly step on a colleague's in-flight work.)`,
    );
  }
  // Free / mine / stale → implicit checkout or refresh (ac-5, ac-20). This is
  // ADVISORY: a failed stamp (e.g. a transient context whose user isn't a
  // persisted row) must NEVER break the user's mutation — the non-negotiable is
  // "never hard-blocked" (ac-7). The collision REJECTION above is the only thing
  // that ever stops a mutation; the implicit stamp is best-effort.
  try {
    await stampCheckout({ docId, userId: ctx.userId, thread: ctx.sessionId ?? null, now: new Date(now) });
  } catch {
    /* advisory checkout stamp — swallow; the mutation proceeds regardless */
  }
}
