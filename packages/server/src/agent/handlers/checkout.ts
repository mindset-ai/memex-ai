// spec-371: the spec-checkout tools — claim_spec / unclaim_spec.
//
// A claim is the explicit checkout that binds a coding-agent thread to a Spec.
// Server-side it is RECORD-ONLY + a soft presence write (dec-5, dec-8): it
// confirms the caller can reach the Spec, writes a presence row on spec-122's
// plane (so teammates see "X is working on spec-N now"), and returns who else is
// present — a SOFT lock surfaced for the human, never a hard block, with no
// takeover / eviction path in v1. The durable thread→Spec binding the edit hook
// reads lives in the CLIENT marker (the plugin watches these very tool calls);
// nothing here reads or needs the MCP transport session beyond presence.

import { z } from "zod";
import { ValidationError } from "../../types/errors.js";
import {
  claimSpecPresence,
  releaseSpecPresence,
} from "../../services/spec-checkout.js";
import type { PresenceChannel, ActorKind } from "../../services/presence.js";
import {
  VERBOSE_FIELD,
  resolveRefArg,
  isDocLikeKind,
  type ToolSpec,
  type ToolCtx,
} from "./shared.js";

const REF_DESC = "Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`.";

function presenceChannelFor(ctx: ToolCtx): PresenceChannel {
  return ctx.channel === "in_app_agent" ? "in_app_agent" : "mcp";
}
function actorKindFor(ctx: ToolCtx): ActorKind {
  return ctx.channel === "in_app_agent" ? "in_app_agent" : "mcp_agent";
}

async function resolveSpec(ctx: ToolCtx, ref: string, tool: string) {
  const resolved = await resolveRefArg(ctx, ref);
  if (!isDocLikeKind(resolved.entity.kind) || resolved.doc.docType !== "spec") {
    throw new ValidationError(
      `${tool} expects a Spec ref (e.g. .../specs/spec-N); got ${resolved.entity.kind}/${resolved.doc.docType}.`,
    );
  }
  return resolved;
}

export const checkoutTools: ToolSpec[] = [
  {
    name: "claim_spec",
    annotations: { title: "Claim spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Check out a Spec for the thread you're working in — the explicit nomination that binds this coding " +
      "session to this Spec, so your in-flow edits are attributed to it. Writes a soft presence marker " +
      "('working on this now') your teammates can see; it is a courtesy lock, never a hard block — anyone " +
      "can still work. Returns who else, if anyone, currently holds it. Idempotent: re-claiming refreshes " +
      "your presence.",
    schema: {
      ref: z.string().describe(REF_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const { memexId, doc } = await resolveSpec(ctx, ref, "claim_spec");
      const { othersPresent } = await claimSpecPresence({
        memexId,
        docId: doc.id,
        actorUserId: ctx.userId,
        actorName: ctx.userName ?? null,
        actorKind: actorKindFor(ctx),
        channel: presenceChannelFor(ctx),
        clientId: ctx.sessionId,
      });
      const lock =
        othersPresent.length > 0
          ? ` Also working here right now: ${othersPresent.join(", ")} — a soft lock, you can both work; coordinate if you'll collide.`
          : "";
      return (
        `ref: ${ref} — checked out for this thread; your in-flow edits are attributed to it ` +
        `until you unclaim or the checkout expires.${lock}`
      );
    },
  },
  {
    name: "unclaim_spec",
    annotations: { title: "Unclaim spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Release your checkout on a Spec — the explicit check-in. Clears your presence marker so teammates " +
      "see it's free, and returns this thread to the silent default (your edits stop being attributed). A " +
      "no-op if you weren't holding it.",
    schema: {
      ref: z.string().describe(REF_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const { doc } = await resolveSpec(ctx, ref, "unclaim_spec");
      await releaseSpecPresence({
        docId: doc.id,
        actorUserId: ctx.userId,
        channel: presenceChannelFor(ctx),
        clientId: ctx.sessionId,
      });
      return `ref: ${ref} — released; this thread is no longer checked out.`;
    },
  },
];
