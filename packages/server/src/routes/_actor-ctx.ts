// spec-122 dec-5 — build the RequestCtx that carries the activity contract from a
// REST request. The authenticated user is on the Hono context (`c.get("user")`,
// set by the session middleware); this is the single seat that turns it into the
// {actorUserId, actorName, channel:'rest_ui'} the source-table services stamp.
//
// When no user is resolved (shouldn't happen on a write route behind auth, but be
// defensive) the ctx is empty — the write still goes through, just unattributed,
// which t-3 surfaces as a visible defect rather than masking with a default.

import type { Context } from "hono";
import { actorCtx } from "../services/actor.js";
import type { RequestCtx } from "../services/mutate.js";

export function restCtx(c: Context): RequestCtx {
  const user = c.get("user");
  return user ? actorCtx(user, "rest_ui") : {};
}
