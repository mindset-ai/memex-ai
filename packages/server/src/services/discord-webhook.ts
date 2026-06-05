// Discord webhook integration (spec-138).
//
// Provides CRUD for the org_discord_webhooks table and a postToDiscord() HTTP
// sender. Webhook URLs are treated as non-secret configuration (no encryption,
// unlike user_slack_tokens) — dec-1. Text is passed to Discord as-is; Discord
// renders GFM natively so no markdown conversion is applied — dec-4.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { orgDiscordWebhooks } from "../db/schema.js";
import { mutate, type Mutated } from "./mutate.js";

export interface DiscordWebhookRow {
  orgId: string;
  webhookUrl: string;
  channelName: string | null;
}

// When specRef is provided, the payload gains an embeds array carrying the Spec
// link footer. The text and url are pre-built by the caller (tool handler).
export interface DiscordEmbedFooter {
  text: string; // e.g. "📄 From Spec: Voice-to-Voice Platform Feature"
  url: string;  // e.g. "https://memex.ai/mindset-prod/memex-building-itself/specs/spec-138"
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function getDiscordWebhook(orgId: string): Promise<DiscordWebhookRow | null> {
  const row = await db.query.orgDiscordWebhooks.findFirst({
    where: eq(orgDiscordWebhooks.orgId, orgId),
  });
  return row ?? null;
}

export async function upsertDiscordWebhook(
  orgId: string,
  webhookUrl: string,
  channelName?: string,
): Promise<Mutated<void>> {
  return mutate(
    {},
    { memexId: "", entity: "org_discord_webhook", action: "updated" },
    async () => {
      await db
        .insert(orgDiscordWebhooks)
        .values({ orgId, webhookUrl, channelName: channelName ?? null })
        .onConflictDoUpdate({
          target: orgDiscordWebhooks.orgId,
          set: {
            webhookUrl,
            channelName: channelName ?? null,
            updatedAt: new Date(),
          },
        });
    },
  );
}

export async function deleteDiscordWebhook(orgId: string): Promise<Mutated<void>> {
  return mutate(
    {},
    { memexId: "", entity: "org_discord_webhook", action: "deleted" },
    async () => {
      await db
        .delete(orgDiscordWebhooks)
        .where(eq(orgDiscordWebhooks.orgId, orgId));
    },
  );
}

// ─── HTTP sender ─────────────────────────────────────────────────────────────

// Builds the wire-format Discord payload and POSTs it to the webhook URL.
//
// Payload shapes (dec-2):
//   no embedFooter → { "content": "<text>" }
//   embedFooter    → { "content": "<text>", "embeds": [{ "footer": { "text": "..." }, "url": "..." }] }
//
// Text is forwarded as-is — no markdown conversion (dec-4). Discord renders
// **bold**, *italic*, `code`, [links](url) natively.
export async function postToDiscord(
  webhookUrl: string,
  content: string,
  embedFooter?: DiscordEmbedFooter,
): Promise<void> {
  // Discord footer fields are plain text only — links don't render there.
  // Using embed description with a markdown hyperlink gives a clickable link.
  const payload = embedFooter
    ? {
        content,
        embeds: [{ description: `[${embedFooter.text}](${embedFooter.url})` }],
      }
    : { content };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook POST failed: ${res.status} ${res.statusText}`);
  }
}
