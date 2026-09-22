// spec-510 t-3 (dec-1, dec-3): emit a static guidance block in full on first
// sight, a one-line pointer thereafter.
//
// THE PROBLEM. `toNudge` re-emits the same blocks on every verbose response.
// Measured on this Scaffold: 10,748 chars in build, 13,058 in specify. The agent
// needs them once; receiving them repeatedly fills the context it was going to
// use for the work, and since spec-538 that guidance is also RESERVED out of the
// response budget — so it crowds out the document the agent actually asked for.
//
// WHERE THIS SITS, AND WHY NOT IN `packages/shared`. Suppressing a block is
// *deciding not to send it*, not *composing text* (dec-1). The decision needs a
// session; a session is request scope; `packages/shared` must stay free of
// request scope so the Scaffold serializes across the server↔React boundary
// [per std-15]. So the projector (`toNudgeBlocks`) stays pure and the decision
// lives here, on the server, driven by the claim store t-1 built.
//
// WHY NOT IN `agent/handlers/` NEXT TO THE SEAT. That directory is scanned as one
// text blob by `guidance-authoring-confined.regression.test.ts`, which pins where
// footer prose may be authored. This module authors none — it selects blocks and
// appends a pointer that comes from the Scaffold — but putting it there would
// make it part of a guard it has no business participating in.
//
// THE POINTER PROSE IS SCAFFOLD DATA (`CADENCE_POINTER`), never a literal here
// [per std-15, spec-219 dec-5].

import { CADENCE_POINTER, type GuidanceBlock } from "@memex/shared";
import { claimOnce, recordGuidanceBytes } from "./session-claims.js";

/** Per-domain debug log [per std-14], same shape as activity-log / comms-log. */
function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[guidance-cadence]", ...args);
}

/** The env var gating the cadence (spec-510 dec-6). */
export const GUIDANCE_CADENCE_FLAG = "GUIDANCE_CADENCE_ENABLED";

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Explicit, default OFF, read LIVE rather than cached at import — the
 * `activation-flag.ts` pattern. Read live is the point: this is a kill switch
 * that takes effect on the next call with no deploy, which matters because the
 * failure mode it guards is silent (an agent quietly less well steered, with no
 * error and no red test). It must also pass through `deploy-config.sh` with
 * set-vs-unset semantics or the next deploy resets a hand-set switch.
 */
export function guidanceCadenceEnabled(): boolean {
  return ON_VALUES.has((process.env[GUIDANCE_CADENCE_FLAG] ?? "").trim().toLowerCase());
}

/**
 * How many guidance bytes a session must receive, SINCE A GIVEN BLOCK was last
 * shown in full, before that block is shown in full again (dec-3).
 *
 * BYTES, not elapsed time and not call count. The failure this guards is that
 * the agent's context was compacted and it FORGOT a block it was shown, and
 * compaction is driven by transcript volume. Time is wrong because an idle
 * session has forgotten nothing. Call count is wrong because per-call variance
 * is extreme — one measured `get_doc` returned 92,070 chars, worth ~300
 * `create_ac` calls.
 *
 * Deliberately GENEROUS on first release: re-showing guidance costs bytes, but
 * never re-showing it costs an agent that has silently lost its steering. The
 * asymmetry says start high and tighten with dogfood evidence (t-9), not the
 * other way round. ~12 build-phase footers' worth.
 */
export const CADENCE_REFRESH_BYTES = 120_000;

export interface CadencedGuidance {
  /** The composed guidance for this response — full blocks, then one pointer. */
  text: string;
  /** How many blocks were replaced by the pointer. Diagnostics only. */
  suppressed: number;
}

/**
 * Apply the cadence to one response's guidance blocks.
 *
 * Returns `undefined` when the cadence must not apply — the flag is off, or the
 * surface has no key (a stateless MCP path, an unbound chat, the first call of a
 * conversation). The caller then composes exactly as it did before this Spec,
 * which is why "no key" is a safe state rather than an error: the fallback is
 * today's behaviour.
 *
 * EVERY block here is suppressible. "Static" in the Spec's prose reads like a
 * subset and is not: this is the whole of `toNudge`'s output — the phase
 * guidance, `about-spec`, the mutation / standards / code-grounding protocols,
 * the classify-and-consult tripwire. The DYNAMIC half — the per-phase counts and
 * the handoff — is composed separately and never passes through here, which is
 * what keeps ac-2's promise that the state line is never suppressed.
 *
 * ONE pointer for the whole suppressed set, not one per block: a dozen pointers
 * would cost more than the prose they replace. Per-block byte markers still
 * govern WHICH blocks return, so a block whose threshold has passed rejoins the
 * full set on that response while its siblings stay behind the same pointer.
 */
export async function composeCadencedGuidance(
  cadenceKey: string | undefined,
  blocks: readonly GuidanceBlock[],
): Promise<CadencedGuidance | undefined> {
  if (!guidanceCadenceEnabled()) return undefined;
  if (!cadenceKey) return undefined;
  if (blocks.length === 0) return { text: "", suppressed: 0 };

  // A STORE THAT CANNOT ANSWER IS "the cadence does not apply" (PR #740 review,
  // M-3). This is fourteen round trips on a verbose build read, and the seat's
  // own catch is not a safety net for them: it returns a footer with no
  // guidance, no handoff, no AC nag, no activity and no state line. So one pool
  // timeout on one upsert would turn a response that should carry guidance IN
  // FULL into one carrying none — the inverse of this function's contract, and
  // worse than the behaviour before this Spec.
  //
  // Guarded HERE rather than at the seat [per std-51]: this function already
  // owns "must not apply" and signals it with undefined, so the failure folds
  // into the path that already has coverage instead of growing a second one. A
  // wider catch at the seat would also swallow failures that should be loud.
  //
  // ALL-OR-NOTHING, deliberately. Catching per block would emit the blocks that
  // happened to claim plus a pointer standing in for the one that failed — a
  // response indistinguishable from a correct cadence that has silently dropped
  // a block this session has never seen.
  try {
    const shown: string[] = [];
    let suppressed = 0;
    for (const block of blocks) {
      // Claimed = "this session has not seen it, or has not seen it for
      // CADENCE_REFRESH_BYTES" → emit in full. Otherwise it stays behind the
      // pointer. The claim is per block, so a block first seen mid-session is not
      // instantly due for a refresh.
      const granted = await claimOnce(cadenceKey, `block:${block.id}`, {
        bytes: CADENCE_REFRESH_BYTES,
      });
      if (granted) shown.push(block.text);
      else suppressed++;
    }

    if (suppressed > 0) shown.push(CADENCE_POINTER);
    return { text: shown.join("\n\n"), suppressed };
  } catch (err) {
    // The ERROR OBJECT, never a stringified message — a silent degrade is
    // forbidden [per std-53, std-50, std-14], and the stack is the only thing
    // that says which of the claims failed.
    log("claim store unavailable — emitting guidance in full:", err);
    return undefined;
  }
}

/**
 * Record what this response actually emitted, so the byte thresholds above
 * measure real volume.
 *
 * ⚠ CALL ORDER IS PART OF THE CONTRACT and getting it wrong is silent. Claim
 * FIRST, record AFTER: a claim granted during this response stamps the total as
 * it stood BEFORE this response, so "bytes since you were last shown this"
 * counts from just before the response that carried it — which is what dec-3
 * describes. Recording first would include the current response in every marker
 * and push every threshold one response late.
 *
 * Never throws and is never awaited for correctness: a failed byte record costs
 * a slightly stale threshold, never a broken tool call.
 */
export async function recordCadenceBytes(
  cadenceKey: string | undefined,
  bytes: number,
): Promise<void> {
  if (!guidanceCadenceEnabled()) return;
  // No key means no claim was made either, so a counter recorded here would
  // never be read against anything.
  if (!cadenceKey || bytes <= 0) return;
  try {
    await recordGuidanceBytes(cadenceKey, bytes);
  } catch {
    // Swallowed deliberately: the cadence is advisory. The cost is a threshold
    // that fires slightly late, and the alternative is a guidance-bookkeeping
    // failure taking down a tool response.
  }
}
