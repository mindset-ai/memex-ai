// spec-444 — welcome-video dismiss gate.
//
// User-level (NOT memex-scoped): the flag lives on the users row, so this
// router is mounted at /api/welcome-video with no /:ns/:mx/ prefix. Both routes
// sit behind the STRICT sessionMiddleware, so anonymous callers are 401'd before
// the handler runs.
//
// PATCH /api/welcome-video
//   Body: (none)
//   Stamps video_welcomed_at = now() for the current user (idempotent — first dismiss wins).
//   Returns the refreshed session payload so the client can call updateSession()
//   before navigating to /specs, preventing a gate re-trigger.

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { markVideoWelcomed } from "../services/users.js";
import { resolveSession } from "../services/auth.js";

const welcomeVideo = new Hono<SessionEnv>();

welcomeVideo.use("/*", sessionMiddleware);

welcomeVideo.patch("/", async (c) => {
  const user = c.get("user");
  await markVideoWelcomed(user.id);
  const resolved = await resolveSession(user.id, null);
  return c.json(resolved);
});

export { welcomeVideo };
