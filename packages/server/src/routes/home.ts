// spec-315 — the graduated Home surface API. Caller-scoped (user-level, no memex):
// Home is a single surface that aggregates across ALL the user's Memex memberships.
// Mounted under /api/me. Polled by the client every ~3s for the ≤4s live freshness (dec-2).
import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { listHomeSpecs } from "../services/home-specs.js";
import { listWhereYoureNeededForUser } from "../services/where-youre-needed.js";

export const homeRouter = new Hono<SessionEnv>();

homeRouter.use("*", sessionMiddleware);

// GET /api/me/home — the graduated home's two derived blocks:
//   whereYoureNeeded — open comments mentioning / assigned to me (spec-320's contract).
//     Assignments rank above bare mentions; each links to the highlighted comment (dec-4).
//   specs — specs I own or have worked on, ownership-tiered (assigned, then created/acted),
//     within 90 days, demo included, each carrying the Pulse-card data (dec-2).
//
// Tenancy is structural: both blocks iterate the user's OWN memberships, so no
// unauthorised Memex can appear (std-7).
homeRouter.get("/home", async (c) => {
  const user = c.get("user");
  const [whereYoureNeeded, specs] = await Promise.all([
    listWhereYoureNeededForUser(user.id),
    listHomeSpecs(user.id),
  ]);
  return c.json({ whereYoureNeeded, specs });
});
