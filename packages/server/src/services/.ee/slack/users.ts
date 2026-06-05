// Display-name → Slack user-ID resolution (doc-23 §6, T-7).
//
// Public surface:
//   resolveSlackUser(userId, query) — look "@christine" or "Christine" up in the
//   workspace's Slack directory, return the U0123ABCDE user ID. Caches the result
//   for 7 days. Throws SlackUserResolutionError on ambiguity / no match / no Slack
//   connection.
//
// Resolution sequence per §6:
//   1. Normalise query: strip leading "@", trim, lowercase
//   2. Cache lookup keyed on (workspace_id, display_name); honour 7-day TTL
//   3. On miss → users.list (paginated) → exact match on display_name OR real_name →
//      fuzzy substring fallback → cache the single match
//   4. Multiple fuzzy matches surface as SlackUserResolutionError("ambiguous", …)
//      with the candidate list so the caller can prompt the user to be more specific
//
// Cache invalidation:
//   - Per-row TTL (7 days) enforced at query time
//   - On token revocation: workspace entries should be purged (TODO: hook into
//     the revoke path from oauth.ts / client.ts — caller-side cleanup, deferred)
//   - Explicit "refresh directory" out of v1 scope per §6

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { db } from "../../../db/connection.js";
import { slackUserCache, userSlackTokens } from "../../../db/schema.js";
import { decryptToken } from "./crypto.js";
import { mutate } from "../../mutate.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SLACK_USERS_LIST_PAGE_SIZE = 200;

export type SlackUserResolutionErrorCode = "not_connected" | "not_found" | "ambiguous";

export interface SlackUserCandidate {
  id: string;
  displayName: string;
}

export class SlackUserResolutionError extends Error {
  constructor(
    public readonly code: SlackUserResolutionErrorCode,
    message: string,
    public readonly candidates?: SlackUserCandidate[],
  ) {
    super(message);
    this.name = "SlackUserResolutionError";
  }
}

export interface ResolvedSlackUser {
  slackUserId: string;
  workspaceId: string;
  source: "cache" | "api";
}

/**
 * Resolve a user-mention string ("@christine" / "Christine") to a Slack user ID.
 * orgId scopes the lookup to the org's connected Slack workspace.
 *
 * @throws SlackUserResolutionError when not connected, no match, or ambiguous.
 */
export async function resolveSlackUser(
  userId: string,
  orgId: string | null,
  query: string,
): Promise<ResolvedSlackUser> {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    throw new SlackUserResolutionError("not_found", "Empty query");
  }

  const tokenRow = await db.query.userSlackTokens.findFirst({
    where: orgId
      ? and(eq(userSlackTokens.userId, userId), eq(userSlackTokens.orgId, orgId))
      : and(eq(userSlackTokens.userId, userId), isNull(userSlackTokens.orgId)),
  });
  if (!tokenRow || tokenRow.revokedAt) {
    throw new SlackUserResolutionError(
      "not_connected",
      `Slack not connected for user ${userId}.`,
    );
  }
  const workspaceId = tokenRow.slackWorkspaceId;

  // 1. Cache lookup with TTL guard
  const cacheCutoff = new Date(Date.now() - CACHE_TTL_MS);
  const cached = await db.query.slackUserCache.findFirst({
    where: and(
      eq(slackUserCache.slackWorkspaceId, workspaceId),
      eq(slackUserCache.displayName, normalized),
      gt(slackUserCache.updatedAt, cacheCutoff),
    ),
  });
  if (cached) {
    return { slackUserId: cached.slackUserId, workspaceId, source: "cache" };
  }

  // 2. Cache miss → users.list (paginated)
  const accessToken = await decryptToken({
    ciphertext: tokenRow.ciphertext,
    iv: tokenRow.iv,
    wrappedDek: tokenRow.wrappedDek,
  });
  const client = new WebClient(accessToken);
  const directory = await listAllSlackUsers(client);

  // 3. Match — exact first, fuzzy fallback
  const matches = matchUsers(directory, normalized);

  if (matches.length === 0) {
    throw new SlackUserResolutionError("not_found", `No Slack user matching "${query}"`);
  }
  if (matches.length > 1) {
    throw new SlackUserResolutionError(
      "ambiguous",
      `Multiple Slack users match "${query}": ${matches
        .map((m) => m.displayName)
        .join(", ")}. Please be more specific.`,
      matches,
    );
  }

  // Single match — cache + return
  const [match] = matches;
  await upsertCacheEntry(workspaceId, normalized, match.id);
  return { slackUserId: match.id, workspaceId, source: "api" };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals — exported only for tests
// ──────────────────────────────────────────────────────────────────────────

export function normalizeQuery(query: string): string {
  return query.trim().replace(/^@/, "").toLowerCase();
}

interface DirectoryEntry {
  id: string;
  displayName: string;
  realName: string;
}

async function listAllSlackUsers(client: WebClient): Promise<DirectoryEntry[]> {
  const out: DirectoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.users.list({
      limit: SLACK_USERS_LIST_PAGE_SIZE,
      cursor,
    });
    if (!response.ok) {
      throw new Error(`Slack users.list returned ok=false: ${response.error ?? "unknown"}`);
    }
    for (const member of response.members ?? []) {
      if (member.deleted || member.is_bot || !member.id) continue;
      const displayName = (member.profile?.display_name ?? "").toLowerCase().trim();
      const realName = (member.profile?.real_name ?? "").toLowerCase().trim();
      if (!displayName && !realName) continue;
      out.push({ id: member.id, displayName, realName });
    }
    const next = response.response_metadata?.next_cursor;
    cursor = next && next.length > 0 ? next : undefined;
  } while (cursor);
  return out;
}

export function matchUsers(
  directory: DirectoryEntry[],
  query: string,
): SlackUserCandidate[] {
  // Exact match wins over fuzzy. An exact match on display_name OR real_name returns
  // immediately — even if there are also fuzzy matches that would be ambiguous.
  const exact = directory.filter(
    (u) => u.displayName === query || u.realName === query,
  );
  if (exact.length > 0) {
    return exact.map((u) => ({
      id: u.id,
      displayName: u.displayName || u.realName,
    }));
  }

  // Fuzzy substring fallback
  const fuzzy = directory.filter(
    (u) => u.displayName.includes(query) || u.realName.includes(query),
  );
  return fuzzy.map((u) => ({
    id: u.id,
    displayName: u.displayName || u.realName,
  }));
}

async function upsertCacheEntry(
  workspaceId: string,
  displayName: string,
  slackUserId: string,
): Promise<void> {
  await mutate(
    {},
    { memexId: "", entity: "slack_user_cache", action: "created" },
    async () => {
      await db
        .insert(slackUserCache)
        .values({
          slackWorkspaceId: workspaceId,
          displayName,
          slackUserId,
        })
        .onConflictDoUpdate({
          target: [slackUserCache.slackWorkspaceId, slackUserCache.displayName],
          set: { slackUserId, updatedAt: sql`now()` },
        });
    },
    { silent: true },
  );
}
