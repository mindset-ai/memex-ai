// spec-315 — the graduated Home surface API. Caller-scoped (user-level, no memex):
// Home is a single surface that aggregates across ALL the user's Memex memberships
// (dec-2/dec-3). Mounted under /api/me.
import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { listSpecsInFlightForUser } from "../services/specs-in-flight.js";
import { listWhereYoureNeededForUser } from "../services/where-youre-needed.js";

export const homeRouter = new Hono<SessionEnv>();

homeRouter.use("*", sessionMiddleware);

// GET /api/me/home — the graduated home's two derived blocks (dec-3):
//   whereYoureNeeded — open comments mentioning / assigned to me, across every Memex
//     I belong to (spec-320's read contract; t-5). Assignments rank above bare mentions.
//   specsInFlight — specs I've recently worked on, across every Memex I belong to (t-1).
//     Each item carries its owning Memex (slug + name) and a canonical route, for the
//     provenance pill and click-through.
//
// Tenancy is structural: both blocks iterate the user's OWN memberships, so no
// unauthorised Memex can appear (std-7).
homeRouter.get("/home", async (c) => {
  const user = c.get("user");
  const [whereYoureNeeded, specsInFlight] = await Promise.all([
    listWhereYoureNeededForUser(user.id),
    listSpecsInFlightForUser(user.id),
  ]);
  return c.json({ whereYoureNeeded, specsInFlight });
});
