// HTTP routes for the Discord webhook settings surface (spec-138).
//
// Mounted under /api/:namespace/:memex/discord-webhook in app.ts.
// One webhook per org — org_id is the natural PK.
//
// Access matrix:
//   GET    /   — any member (read connection status for display)
//   POST   /   — administrator only (upsert webhook URL + optional channel name)
//   DELETE /   — administrator only (hard-delete; no soft-revoke needed for webhooks)

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { adminGate } from "../middleware/permissions.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { getOrgIdForMemex } from "../services/memexes.js";
import {
  getDiscordWebhook,
  upsertDiscordWebhook,
  deleteDiscordWebhook,
} from "../services/discord-webhook.js";
import { ValidationError } from "../types/errors.js";

type Env = MemexResolverEnv & SessionEnv;

const discordWebhookRouter = new Hono<Env>();
discordWebhookRouter.use("/*", sessionMiddleware);

// GET / — read current webhook status (any member)
discordWebhookRouter.get("/", async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await getOrgIdForMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const row = await getDiscordWebhook(orgId);
  if (!row) return c.json({ connected: false });

  return c.json({
    connected: true,
    channelName: row.channelName,
    // Webhook URLs are non-secret config but we still redact them from GET
    // to avoid surfacing the full URL to non-admins unnecessarily.
    webhookUrlPreview: `${row.webhookUrl.slice(0, 40)}…`,
  });
});

// POST / — upsert webhook (admin only)
discordWebhookRouter.post("/", adminGate, async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await getOrgIdForMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  const body = await c.req.json<{ webhookUrl?: unknown; channelName?: unknown }>();
  if (typeof body.webhookUrl !== "string" || body.webhookUrl.trim().length === 0) {
    throw new ValidationError("webhookUrl is required (non-empty string)");
  }
  const webhookUrl = body.webhookUrl.trim();
  if (!webhookUrl.startsWith("https://discord.com/api/webhooks/") &&
      !webhookUrl.startsWith("https://discordapp.com/api/webhooks/")) {
    throw new ValidationError("webhookUrl must be a valid Discord webhook URL");
  }
  const channelName =
    typeof body.channelName === "string" && body.channelName.trim().length > 0
      ? body.channelName.trim()
      : undefined;

  await upsertDiscordWebhook(orgId, webhookUrl, channelName);
  return c.json({ connected: true, channelName: channelName ?? null }, 200);
});

// DELETE / — remove webhook (admin only)
discordWebhookRouter.delete("/", adminGate, async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await getOrgIdForMemex(memexId);
  if (!orgId) return c.json({ error: "Org context required" }, 404);

  await deleteDiscordWebhook(orgId);
  return c.json({ connected: false });
});

export { discordWebhookRouter };
