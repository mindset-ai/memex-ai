// POST /api/:namespace/:memex/handhold/reset — re-seed the handhold onboarding
// demo (spec-178 t-6). Hard-deletes every is_demo Spec in the caller's PERSONAL
// Memex (and the synthetic emissions that back their AC health), then re-seeds
// the five frozen demo Specs from the fixture. Returns { status, seeded }.
//
// This is the user's "reset the tour" button: a personal-namespace owner can
// blow away their experiments on the demo Specs and get a pristine set back.
//
// Authorization (std-7): the demo lives ONLY in personal Memexes, so the reset
// is gated to the owner of a `kind:'user'` namespace. Anyone else — a stranger,
// a member of an ORG Memex, or even the owner pointing at a non-personal Memex —
// gets a 404 (never 403), indistinguishable from a non-existent route, and NO
// mutation runs. The write sits behind the STRICT sessionMiddleware so an
// anonymous caller is 401'd before reaching the handler; the explicit ownership
// gate below then narrows from "any member" to "the personal owner".

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import type { Namespace } from "../db/schema.js";
import { requireMemexId } from "./shared.js";
import { resetHandholdDemo } from "../services/handhold-demo.js";

type Env = MemexResolverEnv & SessionEnv;
const handhold = new Hono<Env>();

// STRICT session policy — this is a mutation. Anonymous → 401, non-member → 404
// (membership proven by sessionMiddleware before the handler runs).
handhold.use("/*", sessionMiddleware);

handhold.post("/reset", async (c) => {
  const memexId = requireMemexId(c);
  const currentUserId = c.get("currentUserId") as string | null;
  // Set by memexResolver from the /<ns>/<mx>/ path prefix; the reset route is
  // path-prefixed only, so this is always present for a resolved Memex.
  const namespace = c.get("namespace") as Namespace | null | undefined;

  // std-7 gate: the demo only exists in a personal Memex, and only its owner may
  // reset it. Anything else (org namespace, someone else's personal namespace,
  // or no resolved namespace at all) → 404, NEVER 403. No mutation runs.
  if (
    !namespace ||
    namespace.kind !== "user" ||
    namespace.ownerUserId !== currentUserId
  ) {
    return c.json({ error: "Not found" }, 404);
  }

  const result = await resetHandholdDemo(memexId);
  return c.json({ status: "ok", seeded: result.seeded });
});

export { handhold };
