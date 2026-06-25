// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  eq,
  and,
  inArray,
} from "drizzle-orm";
import {
  db,
} from "../../db/connection.js";
import {
  documents,
} from "../../db/schema.js";
import {
  memexSlugsById,
} from "../../mcp/refs.js";
import {
  getDoc,
} from "../../services/documents.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  getDiscordWebhook,
  postToDiscord,
} from "../../services/discord-webhook.js";
import {
  getSlackClientForUser,
  SlackClientError,
} from "../../services/.ee/slack/client.js";
import {
  resolveSlackUser,
  SlackUserResolutionError,
} from "../../services/.ee/slack/users.js";
import {
  getSlackBotUserId,
} from "../../services/.ee/slack/oauth.js";
import {
  getOrgIdForMemex,
} from "../../services/memexes.js";
import {
  markdownToMrkdwn,
} from "../../services/slack-markdown.js";
import {
  buildTenantUrl,
} from "../../services/shared/tenant-url.js";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  type ToolSpec,
} from "./shared.js";

export const integrationsTools: ToolSpec[] = [
  {
    name: "memex__send_discord_message",
    annotations: { title: "Send Discord message", readOnlyHint: false, destructiveHint: false },
    description:
      "Send a message to a Discord channel via the org's configured webhook URL. " +
      "Use for AI → human handoffs: status updates, notifications, or flagging decisions without leaving the agent workflow. " +
      "Requires an org admin to have configured a Discord webhook at /settings/integrations. " +
      "Supports standard Markdown — **bold**, *italic*, `code`, [links](url), # headings — rendered natively by Discord (no conversion applied).",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      channelOrUser: z
        .string()
        .optional()
        .describe(
          "Ignored for Discord (the webhook URL already encodes the target channel). " +
          "Accepted for API parity with memex__send_slack_message.",
        ),
      text: z
        .string()
        .describe(
          "Message text. Standard Markdown is rendered natively by Discord — " +
          "**bold**, *italic*, `code`, [text](url), # headings all work as-is.",
        ),
      specRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref of the originating Spec (e.g. `mindset-prod/memex-building-itself/specs/spec-138`). " +
          "When provided, a footer embed with a clickable link to the Spec is appended. " +
          "Always pass this when sending from inside a Spec context.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const text = input.text as string;
      const specRef = input.specRef as string | undefined;

      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      let orgId = await getOrgIdForMemex(memexId);

      // Personal Memex has no org — auto-discover an org the user belongs to
      // that has a Discord webhook configured (common case: one org, one webhook).
      if (!orgId) {
        const { orgMemberships, orgDiscordWebhooks } = await import("../../db/schema.js");
        const memberships = await db
          .select({ orgId: orgMemberships.orgId })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.userId, ctx.userId),
              eq(orgMemberships.status, "active"),
            ),
          );
        const orgIds = memberships.map((m) => m.orgId);
        if (orgIds.length > 0) {
          const webhooks = await db
            .select({ orgId: orgDiscordWebhooks.orgId })
            .from(orgDiscordWebhooks)
            .where(inArray(orgDiscordWebhooks.orgId, orgIds));
          if (webhooks.length === 1) {
            orgId = webhooks[0].orgId;
          } else if (webhooks.length > 1) {
            throw new ValidationError(
              "Multiple orgs have Discord webhooks configured. Pass the `memex` parameter to specify which org to use.",
            );
          }
        }
      }

      if (!orgId) {
        throw new ValidationError(
          "No Discord webhook configured. Ask an org admin to add one at /settings/integrations.",
        );
      }

      const webhook = await getDiscordWebhook(orgId);
      if (!webhook) {
        throw new ValidationError(
          "No Discord webhook configured for this org. Ask an admin to add one at /settings/integrations.",
        );
      }

      const explicitSpec = specRef
        ? await ctx.resolveRef(specRef).catch(() => null)
        : null;

      // Auto-build the footer from the current doc when specRef is omitted.
      // The /chat route always passes currentDocId when the agent is bound to a
      // Spec — fall back to it so the footer is consistent without requiring the
      // agent to remember to pass the parameter.
      // Format mirrors the Slack context block: **Spec:** [title](url) _(handle)_  ·  Sent via Memex
      const embedFooter = await (async () => {
        const buildDescription = (title: string, _handle: string, url: string) =>
          `**Spec:** [${title}](${url})`;

        if (explicitSpec) {
          const url = `${buildTenantUrl(explicitSpec.slugs)}/specs/${explicitSpec.doc.handle}`;
          return { description: buildDescription(explicitSpec.doc.title, explicitSpec.doc.handle, url) };
        }
        if (!ctx.currentDocId) return undefined;
        const [doc, slugs] = await Promise.all([
          db.query.documents.findFirst({ where: eq(documents.id, ctx.currentDocId) }),
          memexSlugsById(memexId),
        ]);
        if (!doc || !slugs) return undefined;
        const url = `${buildTenantUrl(slugs)}/specs/${doc.handle}`;
        return { description: buildDescription(doc.title, doc.handle, url) };
      })();

      await postToDiscord(webhook.webhookUrl, text, embedFooter);

      return embedFooter
        ? `sent to Discord channel ${webhook.channelName ?? webhook.webhookUrl} with Spec footer`
        : `sent to Discord channel ${webhook.channelName ?? webhook.webhookUrl}`;
    },
  },

  // ── Slack integration (doc-23 T-6) ────────────────────────
  {
    name: "memex__send_slack_message",
    annotations: { title: "Send Slack message", readOnlyHint: false, destructiveHint: false },
    description:
      "Send a Slack message as the current user via their connected Slack identity. " +
      "Use for AI → human handoffs: pinging a teammate for input, sending a status update, or flagging a question without leaving the agent workflow. " +
      "Messages appear in Slack attributed to the user — not a bot. " +
      "Requires the user to have connected Slack at /settings/integrations. " +
      "Target can be a channel (`#general`, `C0123456`), a DM user ID (`U0123456`), or a display name (`@christine` / `Christine Lee`) which is resolved via the workspace directory.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      channelOrUser: z
        .string()
        .describe(
          "Slack target: a channel name (`#general`), channel ID (`C0123456`), " +
          "user ID (`U0123456`), or display name (`@christine` / `Christine Lee`). " +
          "Display names are resolved against the workspace directory.",
        ),
      text: z
        .string()
        .describe(
          "Message text. Supports Markdown — **bold**, *italic*, `code`, [text](url), # Heading. " +
          "Converted to Slack mrkdwn before sending. `<@U0123456>` mention syntax is supported inline.",
        ),
      specRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref of the originating Spec (e.g. `mindset-prod/memex-building-itself/specs/spec-71`). " +
          "When provided, a context block footer with a clickable link to the Spec is appended. " +
          "Always pass this when sending from inside a Spec context.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const channelOrUser = input.channelOrUser as string;
      const text = markdownToMrkdwn(input.text as string);
      const specRef = input.specRef as string | undefined;

      // Resolve org from active memex — null for personal memexes (uses personal Slack token).
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      const orgId = await getOrgIdForMemex(memexId);

      const slackClient = await getSlackClientForUser(ctx.userId, orgId).catch((err) => {
        if (err instanceof SlackClientError && err.code === "not_connected") {
          throw new ValidationError(
            "Slack not connected for this org. Ask the user to visit /settings/integrations to connect their Slack account.",
          );
        }
        throw err;
      });

      // Resolve the target:
      //   - Slack IDs (U…, W…, C…, G…, D…) → pass through directly
      //   - #channel-name → pass through directly (Slack API accepts this natively)
      //   - display name (@christine, "Christine Lee") → directory lookup
      let channel: string;
      if (/^[UCGWDB][A-Z0-9]{6,}$/i.test(channelOrUser.trim()) || channelOrUser.trim().startsWith('#')) {
        channel = channelOrUser.trim();
      } else {
        const resolved = await resolveSlackUser(ctx.userId, orgId, channelOrUser).catch((err) => {
          if (err instanceof SlackUserResolutionError) {
            if (err.code === "ambiguous") {
              const names = err.candidates?.map((c) => c.displayName).join(", ") ?? "";
              throw new ValidationError(
                `Ambiguous Slack target "${channelOrUser}". Matching users: ${names}. Please be more specific.`,
              );
            }
            if (err.code === "not_found") {
              throw new ValidationError(
                `No Slack user matching "${channelOrUser}". Try the exact display name or use a channel name like #general.`,
              );
            }
            throw new ValidationError(`Slack directory error: ${err.message}`);
          }
          throw err;
        });
        channel = resolved.slackUserId;
      }

      const [botUserId, specDoc, explicitSpec] = await Promise.all([
        getSlackBotUserId(ctx.userId, orgId),
        ctx.currentDocId
          ? getDoc(memexId, ctx.currentDocId).catch(() => null)
          : Promise.resolve(null),
        specRef
          ? ctx.resolveRef(specRef).catch(() => null)
          : Promise.resolve(null),
      ]);

      const sentBy = botUserId ? `<@${botUserId}>` : "Memex";

      let footerText: string;
      if (explicitSpec) {
        const specUrl = `${buildTenantUrl(explicitSpec.slugs)}/specs/${explicitSpec.doc.handle}`;
        footerText = `📄 From: <${specUrl}|${explicitSpec.doc.handle}>  ·  Sent via ${sentBy}`;
      } else {
        const specLine = specDoc ? `*Spec:* ${specDoc.title} _(${specDoc.handle})_` : null;
        footerText = specLine ? `${specLine}  ·  Sent via ${sentBy}` : `Sent via ${sentBy}`;
      }

      const blocks = [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "context", elements: [{ type: "mrkdwn", text: footerText }] },
      ];
      const result = await slackClient.postMessage({ channel, text, blocks }).catch((err) => {
        if (err instanceof SlackClientError) {
          if (err.code === "reconnect_required") {
            throw new ValidationError(
              "Slack token revoked. Ask the user to reconnect at /settings/integrations.",
            );
          }
          throw new ValidationError(`Slack error (${err.code}): ${err.message}`);
        }
        throw err;
      });

      return `sent: ts=${result.ts} channel=${result.channel}`;
    },
  },
];
