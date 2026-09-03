// spec-371: the spec-checkout tools — claim_spec / unclaim_spec.
//
// A claim is the EXPLICIT checkout that binds a thread to a Spec. Server-side it
// stamps the durable, single-holder CHECKOUT record on the spec's own documents
// row (checked_out_by/at/thread, dec-5) — NOT the presence plane (the merged v1's
// mistake; presence is ephemeral viewing and untouched here). Explicit claim
// ALWAYS succeeds and takes over, even when another user holds it within the
// collision window — it returns a who/when heads-up but never errors or blocks
// (dec-11, ac-22). The durable thread→Spec binding the edit hook reads still lives
// in the CLIENT marker (the plugin watches these very tool calls).

import { z } from "zod";
import { ValidationError } from "../../types/errors.js";
import {
  getCheckout,
  collisionAgainst,
  stampCheckout,
  describeCollision,
  releaseCheckout,
} from "../../services/checkout.js";
import {
  VERBOSE_FIELD,
  resolveRefArg,
  isDocLikeKind,
  type ToolSpec,
  type ToolCtx,
} from "./tool-contract.js";

const REF_DESC = "Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`.";

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
      "session to this Spec, so your in-flow edits are attributed to it. You rarely need to call this by " +
      "hand: editing anything on a Spec checks it out for you automatically. Use it to take over a Spec a " +
      "colleague recently held (it always succeeds — never blocked), or to bind a Spec you'll build in a " +
      "different thread. Returns a heads-up if you've just taken it over from someone. Idempotent.",
    schema: {
      ref: z.string().describe(REF_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const { doc } = await resolveSpec(ctx, ref, "claim_spec");
      // Compute the collision BEFORE we overwrite the holder, for the heads-up.
      const collision = collisionAgainst(await getCheckout(doc.id), ctx.userId);
      // Explicit claim ALWAYS takes over — never errors, even on a collision (ac-22).
      await stampCheckout({ docId: doc.id, userId: ctx.userId, thread: ctx.sessionId ?? null });
      let heads = "";
      if (collision) {
        const { holderName, minutesAgo } = await describeCollision(collision);
        heads =
          ` Heads-up: ${holderName} checked this out ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago` +
          ` — you've taken it over. Coordinate with them if you'll collide.`;
      }
      return (
        `ref: ${ref} — checked out for this thread; your in-flow edits are attributed to it ` +
        `until you unclaim or it's taken over.${heads}`
      );
    },
  },
  {
    name: "unclaim_spec",
    annotations: { title: "Unclaim spec", readOnlyHint: false, destructiveHint: false },
    description:
      "Release your checkout on a Spec — the explicit check-in. Frees the Spec so it reads as un-held, and " +
      "returns this thread to the silent default (your edits stop being attributed). A no-op if you weren't " +
      "the current holder (so it can't evict whoever took it over).",
    schema: {
      ref: z.string().describe(REF_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const { doc } = await resolveSpec(ctx, ref, "unclaim_spec");
      await releaseCheckout(doc.id, ctx.userId);
      return `ref: ${ref} — released; this thread is no longer checked out.`;
    },
  },
];
