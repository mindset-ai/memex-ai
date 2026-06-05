import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, mcpTokens } from "../db/schema.js";
import {
  mintMcpToken,
  verifyMcpToken,
  bumpLastUsed,
  listMcpTokensForUser,
  revokeMcpToken,
} from "./mcp-tokens.js";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function makeUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-tok-${suffix}-${Date.now()}@memex.ai` } as any)
    .returning();
  createdUserIds.push(u.id);
  return u;
}

describe("mcp-tokens service", () => {
  it("mints a token with mxt_ prefix and stores it hashed", async () => {
    const u = await makeUser("mint");
    const { raw, row } = await mintMcpToken(u.id, "MacBook Pro");

    expect(raw).toMatch(/^mxt_[A-Za-z0-9_-]+$/);
    expect(row.userId).toBe(u.id);
    expect(row.label).toBe("MacBook Pro");
    expect(row.prefix.startsWith("mxt_")).toBe(true);
    expect(row.prefix.length).toBe(12); // mxt_ + 8 chars
    // Stored hash should NOT equal the raw value
    expect(row.tokenHash).not.toBe(raw);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies the raw token back to the row", async () => {
    const u = await makeUser("verify");
    const { raw, row } = await mintMcpToken(u.id, "Verify Test");

    const found = await verifyMcpToken(raw);
    expect(found?.id).toBe(row.id);
  });

  it("returns null for an invalid token", async () => {
    expect(await verifyMcpToken("mxt_wronginvalidtoken")).toBeNull();
    expect(await verifyMcpToken("not-a-mcp-token")).toBeNull();
    expect(await verifyMcpToken("")).toBeNull();
  });

  it("returns null for revoked tokens", async () => {
    const u = await makeUser("revoke");
    const { raw, row } = await mintMcpToken(u.id, "ToRevoke");
    await revokeMcpToken(row.id, u.id);

    expect(await verifyMcpToken(raw)).toBeNull();
  });

  it("revoke is scoped to the owning user", async () => {
    const owner = await makeUser("owner");
    const stranger = await makeUser("stranger");
    const { raw, row } = await mintMcpToken(owner.id, "OwnedToken");

    const result = await revokeMcpToken(row.id, stranger.id);
    expect(result).toBeNull();

    // Token still works
    expect(await verifyMcpToken(raw)).not.toBeNull();
  });

  it("lists user tokens newest-first", async () => {
    const u = await makeUser("list");
    await mintMcpToken(u.id, "first");
    await new Promise((r) => setTimeout(r, 10));
    await mintMcpToken(u.id, "second");

    const list = await listMcpTokensForUser(u.id);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("second");
    expect(list[1].label).toBe("first");
  });

  it("bumpLastUsed updates the timestamp", async () => {
    const u = await makeUser("bump");
    const { row } = await mintMcpToken(u.id, "BumpTest");

    expect(row.lastUsedAt).toBeNull();
    bumpLastUsed(row.id);
    // bump is fire-and-forget; wait briefly for it to land
    await new Promise((r) => setTimeout(r, 50));

    const refetched = await db.query.mcpTokens.findFirst({
      where: (t, { eq }) => eq(t.id, row.id),
    });
    expect(refetched?.lastUsedAt).not.toBeNull();
  });
});
