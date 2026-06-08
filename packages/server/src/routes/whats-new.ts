// spec-200 t-4: the What's New feed read API.
//
// GET /api/whats-new → the GLOBAL feed (dec-3), newest-first, identical for
// every authenticated user regardless of which namespace/memex they're viewing.
// Pure stored read — NO LLM call on this path (dec-2 / ac-8 read side); content
// is generated at the daily prod promotion (t-3) and stored (t-1).

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { listEntries } from "../services/whats-new.js";

export const whatsNewRouter = new Hono<SessionEnv>();

// Logged-in users only — it's product news, not public, but it carries no
// per-user/per-tenant data so there's no memex scoping.
whatsNewRouter.use("/*", sessionMiddleware);

whatsNewRouter.get("/", async (c) => {
  const entries = await listEntries();
  return c.json({
    entries: entries.map((e) => ({
      id: e.id,
      sourceSpecRef: e.sourceSpecRef,
      sourceSpecHandle: e.sourceSpecHandle,
      title: e.title,
      what: e.whatText,
      why: e.whyText,
      publishedAt: e.publishedAt,
    })),
  });
});
