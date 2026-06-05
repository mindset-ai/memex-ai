import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { mcpTokens, type McpToken } from "../db/schema.js";
import { mutate, type Mutated } from "./mutate.js";

// mcp_tokens is user-scoped (no memex column). Mint/revoke emit on the unified
// bus with memexId="" + userId set — the /api/me/events SSE channel filters by
// userId so /settings/tokens reacts in real time across tabs. The lastUsedAt
// heartbeat stays silent (no user-observable change; see std-8 §5 opt-out).

// Token shape: `mxt_<32 url-safe chars>`. Stored hashed; the prefix (first 8 chars) is
// kept plaintext so the settings UI can show "mxt_a1b2c3d4…" without compromising the
// secret. mxt_ namespace makes these instantly recognisable in logs and error messages.
const TOKEN_PREFIX = "mxt_";
const TOKEN_RANDOM_BYTES = 24; // 24 bytes → 32 chars base64url

function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function displayPrefix(raw: string): string {
  // First 8 chars after `mxt_` — enough to disambiguate in a settings list without
  // leaking the secret.
  return raw.slice(0, TOKEN_PREFIX.length + 8);
}

export interface MintedToken {
  raw: string;
  row: McpToken;
}

export async function mintMcpToken(userId: string, label: string): Promise<Mutated<MintedToken>> {
  const raw = generateRawToken();
  return mutate(
    {},
    { memexId: "", userId, entity: "mcp_token", action: "created" },
    async () => {
      const [row] = await db
        .insert(mcpTokens)
        .values({
          userId,
          label,
          tokenHash: hashToken(raw),
          prefix: displayPrefix(raw),
        })
        .returning();
      return { raw, row };
    },
  );
}

// Returns the active token row if the raw token matches an unrevoked record.
// Caller is responsible for bumping lastUsedAt (async, non-blocking) on hot paths.
export async function verifyMcpToken(raw: string): Promise<McpToken | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(raw);
  const row = await db.query.mcpTokens.findFirst({
    where: and(eq(mcpTokens.tokenHash, hash), isNull(mcpTokens.revokedAt)),
  });
  return row ?? null;
}

// Fire-and-forget update. Failures are swallowed because they can't block the request
// they're attached to — the only consequence of a missed bump is a stale lastUsedAt.
// Per the Reactivity Standard (std-8) opt-out criteria: heartbeat writes produce no
// user-observable change. silent: true is the documented exception.
export function bumpLastUsed(tokenId: string): void {
  void mutate(
    {},
    { memexId: "", entity: "mcp_token", action: "updated" },
    async () => {
      await db
        .update(mcpTokens)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(mcpTokens.id, tokenId));
    },
    { silent: true },
  ).catch((err) => {
    console.warn("[mcp-tokens] bumpLastUsed failed", err);
  });
}

export async function listMcpTokensForUser(userId: string): Promise<McpToken[]> {
  return db.query.mcpTokens.findMany({
    where: eq(mcpTokens.userId, userId),
    orderBy: [desc(mcpTokens.createdAt)],
  });
}

// Revoke is scoped to the owning user — settings page only ever touches its own tokens.
// Returns the updated row or null if not found / not owned by `userId`.
export async function revokeMcpToken(
  tokenId: string,
  userId: string
): Promise<Mutated<McpToken | null>> {
  return mutate(
    {},
    { memexId: "", userId, entity: "mcp_token", action: "deleted" },
    async () => {
      const [row] = await db
        .update(mcpTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId)))
        .returning();
      return row ?? null;
    },
  );
}
