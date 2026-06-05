// spec-180: resolve which messaging integrations are active for the current
// request. The logic mirrors each tool's own credential-resolution path so
// the injected system-prompt block can never diverge from what the tools
// report at call time.
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { orgDiscordWebhooks, orgMemberships, userSlackTokens } from "../db/schema.js";
import { getOrgIdForMemex } from "../services/memexes.js";

export interface IntegrationState {
  slackConnected: boolean;
  discordConnected: boolean;
  discordAmbiguous: boolean;
  discordChannelName: string | null;
}

/**
 * Mirrors the credential resolution used by memex__send_discord_message and
 * memex__send_slack_message so the injected system-prompt block reflects what
 * the tools will actually do at execution time.
 *
 * Discord: tries the memex's owning org first; if the memex has no org
 * (personal namespace), auto-discovers across the user's active memberships —
 * same auto-discovery path as the Discord tool.
 *
 * Slack: queries userSlackTokens with the same (userId, orgId) filter and
 * revokedAt check as getSlackClientForUser in services/.ee/slack/client.ts.
 */
export async function resolveIntegrationState(
  memexId: string,
  userId: string | undefined,
): Promise<IntegrationState> {
  const orgId = await getOrgIdForMemex(memexId);

  // Discord resolution — mirrors send_discord_message handler.
  let discordOrgId = orgId;
  let discordAmbiguous = false;

  if (!discordOrgId && userId) {
    const memberships = await db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active")));

    const orgIds = memberships.map((m) => m.orgId);
    if (orgIds.length > 0) {
      const webhooks = await db
        .select({ orgId: orgDiscordWebhooks.orgId })
        .from(orgDiscordWebhooks)
        .where(inArray(orgDiscordWebhooks.orgId, orgIds));

      if (webhooks.length === 1) {
        discordOrgId = webhooks[0].orgId;
      } else if (webhooks.length > 1) {
        discordAmbiguous = true;
      }
    }
  }

  // Slack resolution — mirrors getSlackClientForUser in services/.ee/slack/client.ts.
  // orgId null → isNull() to match the legacy global-token fallback path.
  const slackWhere = userId
    ? and(
        eq(userSlackTokens.userId, userId),
        orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId),
      )
    : undefined;

  const [discordWebhook, slackToken] = await Promise.all([
    discordOrgId
      ? db.query.orgDiscordWebhooks.findFirst({
          where: eq(orgDiscordWebhooks.orgId, discordOrgId),
        })
      : Promise.resolve(undefined),
    slackWhere
      ? db.query.userSlackTokens.findFirst({ where: slackWhere })
      : Promise.resolve(undefined),
  ]);

  return {
    slackConnected: !!(slackToken && !slackToken.revokedAt),
    discordConnected: discordAmbiguous || !!discordWebhook,
    discordAmbiguous,
    discordChannelName: discordWebhook?.channelName ?? null,
  };
}
