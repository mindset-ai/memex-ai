// Slack message-send client (doc-23 §4).
//
// Wraps @slack/web-api's WebClient pinned to chat.postMessage only — no other Slack
// methods are exposed. Every send goes through getSlackClientForUser(userId), which
// looks up the user's user_slack_tokens row, decrypts the token via crypto.ts, and
// returns a thin typed surface.
//
// Error mapping (§4):
//   token_revoked / not_authed   → mark row revoked, throw "reconnect_required"
//   channel_not_found            → throw "channel_not_found" (token NOT marked revoked)
//   not_in_channel               → throw "not_in_channel"
//   ratelimited                  → retry once after Retry-After; on second failure
//                                  throw "rate_limited"
//   invalid_arguments            → throw "invalid_arguments"
//   network / 5xx                → throw "transient" (token NOT marked revoked)

import { and, eq, isNull, sql } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { db } from "../../../db/connection.js";
import { userSlackTokens } from "../../../db/schema.js";
import { decryptToken } from "./crypto.js";
import { mutate } from "../../mutate.js";

export type SlackErrorCode =
  | "not_connected"
  | "reconnect_required"
  | "channel_not_found"
  | "not_in_channel"
  | "rate_limited"
  | "invalid_arguments"
  | "transient";

export class SlackClientError extends Error {
  constructor(
    public readonly code: SlackErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SlackClientError";
  }
}

export interface SlackPostResult {
  ts: string;
  channel: string;
}

export interface SlackClient {
  postMessage(params: {
    channel: string;
    text: string;
    thread_ts?: string;
    /** Block Kit blocks. When provided, `text` serves as the fallback for notifications. */
    blocks?: object[];
  }): Promise<SlackPostResult>;
}

/**
 * Resolve a user's org-scoped Slack-token row, decrypt the token, and return a typed client.
 * Throws SlackClientError("not_connected") if the user has no row for this org or it has been revoked.
 */
export async function getSlackClientForUser(userId: string, orgId: string | null): Promise<SlackClient> {
  const orgWhere = orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId);
  const row = await db.query.userSlackTokens.findFirst({
    where: and(eq(userSlackTokens.userId, userId), orgWhere),
  });
  if (!row || row.revokedAt) {
    throw new SlackClientError(
      "not_connected",
      `Slack not connected for user ${userId} in this org. Visit /settings/integrations to connect.`,
    );
  }
  const accessToken = await decryptToken({
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedDek: row.wrappedDek,
  });
  return wrapWebClient(new WebClient(accessToken), userId, orgId);
}

// ──────────────────────────────────────────────────────────────────────────
// Internal — wrapping + error mapping
// ──────────────────────────────────────────────────────────────────────────

// Exported so tests can inject a fake WebClient without going through OAuth + crypto.
export function wrapWebClient(client: WebClient, userId: string, orgId: string | null): SlackClient {
  return {
    async postMessage(params): Promise<SlackPostResult> {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await client.chat.postMessage({
            channel: params.channel,
            text: params.text,
            thread_ts: params.thread_ts,
            ...(params.blocks ? { blocks: params.blocks } : {}),
          });
          if (!response.ok || !response.ts) {
            throw new SlackClientError(
              "transient",
              `Slack chat.postMessage returned not-ok: ${response.error ?? "unknown"}`,
              response,
            );
          }
          return {
            ts: response.ts,
            channel: response.channel ?? params.channel,
          };
        } catch (err) {
          lastErr = err;
          if (isRateLimited(err) && attempt === 1) {
            const retryAfterMs = (parseRetryAfter(err) ?? 1) * 1000;
            await sleep(retryAfterMs);
            continue;
          }
          throw await mapSlackError(err, userId, orgId);
        }
      }
      throw new SlackClientError(
        "rate_limited",
        "Slack rate-limited after one retry. Try again later.",
        lastErr,
      );
    },
  };
}

async function mapSlackError(err: unknown, userId: string, orgId: string | null): Promise<SlackClientError> {
  if (err instanceof SlackClientError) return err;

  const slackCode = extractSlackErrorCode(err);

  switch (slackCode) {
    case "token_revoked":
    case "not_authed":
    case "invalid_auth":
    case "account_inactive": {
      // Side effect: mark the user_slack_tokens row revoked so subsequent calls fail
      // fast with not_connected. Fire-and-forget to avoid masking the original error.
      void markRevoked(userId, orgId).catch(() => {
        // Swallow: best-effort. The not_connected check on next call still protects us.
      });
      return new SlackClientError(
        "reconnect_required",
        "Slack token was revoked or invalidated. Direct user to /settings/integrations.",
        err,
      );
    }
    case "channel_not_found":
      return new SlackClientError("channel_not_found", "Slack channel not found", err);
    case "not_in_channel":
      return new SlackClientError(
        "not_in_channel",
        "Slack user is not a member of that channel",
        err,
      );
    case "invalid_arguments":
    case "msg_too_long":
    case "no_text":
      return new SlackClientError(
        "invalid_arguments",
        `Invalid arguments to Slack chat.postMessage: ${slackCode}`,
        err,
      );
    case "ratelimited":
      return new SlackClientError(
        "rate_limited",
        "Slack rate-limited the request",
        err,
      );
    default:
      return new SlackClientError(
        "transient",
        `Slack API error: ${slackCode ?? "network/unknown"}`,
        err,
      );
  }
}

async function markRevoked(userId: string, orgId: string | null): Promise<void> {
  const orgWhere = orgId ? eq(userSlackTokens.orgId, orgId) : isNull(userSlackTokens.orgId);
  await mutate(
    {},
    { memexId: "", userId, entity: "user_slack_token", action: "updated" },
    async () => {
      await db
        .update(userSlackTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(userSlackTokens.userId, userId), orgWhere));
    },
  );
}

function isRateLimited(err: unknown): boolean {
  return (
    extractSlackErrorCode(err) === "ratelimited" ||
    (err as { code?: string })?.code === "slack_webapi_rate_limited_error"
  );
}

function parseRetryAfter(err: unknown): number | null {
  // @slack/web-api surfaces retryAfter directly on rate-limit errors.
  const retryAfter = (err as { retryAfter?: number })?.retryAfter;
  if (typeof retryAfter === "number") return retryAfter;

  // Fall back to the Retry-After header if the SDK didn't extract it.
  const headers =
    (err as { headers?: Record<string, string> })?.headers ??
    (err as { data?: { headers?: Record<string, string> } })?.data?.headers;
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function extractSlackErrorCode(err: unknown): string | undefined {
  return (
    (err as { data?: { error?: string } })?.data?.error ??
    (err as { error?: string })?.error
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
