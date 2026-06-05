import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, mcpTokens, cliAuthRequests } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";

// Force dev mode so sessionMiddleware uses the dev-user fallback.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

const createdUserIds: string[] = [];
const createdReqIds: string[] = [];

afterAll(async () => {
  if (createdReqIds.length) {
    await db.delete(cliAuthRequests).where(inArray(cliAuthRequests.id, createdReqIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function appReq(path: string, init: RequestInit = {}) {
  const { app } = await import("../app.js");
  return app.request(path, init);
}

describe("POST /api/cli/auth/start", () => {
  it("returns a reqId and human code without auth", async () => {
    const res = await appReq("/api/cli/auth/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reqId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    createdReqIds.push(body.reqId);
  });
});

describe("GET /api/cli/auth/lookup", () => {
  it("requires session", async () => {
    // Dev mode auto-sessions; this test confirms the route works rather than that
    // session is enforced. Session enforcement is covered in middleware tests.
    const start = await (await appReq("/api/cli/auth/start", { method: "POST" })).json();
    createdReqIds.push(start.reqId);

    const res = await appReq(`/api/cli/auth/lookup?code=${start.code}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
  });

  it("404s for unknown code", async () => {
    const res = await appReq("/api/cli/auth/lookup?code=ZZZZ-ZZZZ");
    expect(res.status).toBe(404);
  });

  it("400s when code is missing", async () => {
    const res = await appReq("/api/cli/auth/lookup");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cli/auth/complete", () => {
  it("mints an mcp_token for the logged-in user", async () => {
    const start = await (await appReq("/api/cli/auth/start", { method: "POST" })).json();
    createdReqIds.push(start.reqId);

    const devUser = await upsertUserByEmail("dev@memex.ai");
    if (!createdUserIds.includes(devUser.id)) createdUserIds.push(devUser.id);

    const res = await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: start.code, label: "TestMachine" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const tokens = await db.query.mcpTokens.findMany({
      where: eq(mcpTokens.userId, devUser.id),
    });
    expect(tokens.find((t) => t.label === "TestMachine")).toBeDefined();
  });

  it("rejects missing fields", async () => {
    const res1 = await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ABCD-1234" }),
    });
    expect(res1.status).toBe(400);

    const res2 = await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "X" }),
    });
    expect(res2.status).toBe(400);
  });

  it("404s for unknown code", async () => {
    const res = await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ZZZZ-ZZZZ", label: "X" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/cli/auth/poll/:reqId", () => {
  it("returns the token after complete (single-shot consume)", async () => {
    const start = await (await appReq("/api/cli/auth/start", { method: "POST" })).json();
    createdReqIds.push(start.reqId);

    await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: start.code, label: "PollTest" }),
    });

    const res = await appReq(`/api/cli/auth/poll/${start.reqId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.token).toMatch(/^mxt_/);

    // Second poll should not re-return the token
    const res2 = await appReq(`/api/cli/auth/poll/${start.reqId}`);
    const body2 = await res2.json();
    expect(body2.token).toBeUndefined();
  });

  it("404s for unknown reqId", async () => {
    const res = await appReq("/api/cli/auth/poll/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
}, 35000);

describe("GET/DELETE /api/mcp/tokens", () => {
  it("lists the dev user's tokens, then revokes one", async () => {
    // First mint a token via the device flow to ensure there's at least one
    const start = await (await appReq("/api/cli/auth/start", { method: "POST" })).json();
    createdReqIds.push(start.reqId);
    await appReq("/api/cli/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: start.code, label: "ListTest" }),
    });

    const list = await appReq("/api/mcp/tokens");
    expect(list.status).toBe(200);
    const tokens: Array<{ id: string; label: string; prefix: string; revokedAt: string | null }> = await list.json();
    const target = tokens.find((t) => t.label === "ListTest");
    expect(target).toBeDefined();
    expect(target?.prefix.startsWith("mxt_")).toBe(true);

    const del = await appReq(`/api/mcp/tokens/${target!.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await del.json();
    expect(after.revokedAt).not.toBeNull();
  });

  it("404s when revoking another user's token", async () => {
    const otherUser = await upsertUserByEmail(`stranger-${Date.now()}@memex.ai`);
    createdUserIds.push(otherUser.id);
    const [token] = await db
      .insert(mcpTokens)
      .values({
        userId: otherUser.id,
        label: "Other",
        tokenHash: "hash" + Date.now(),
        prefix: "mxt_zzzz",
      } as any)
      .returning();

    const res = await appReq(`/api/mcp/tokens/${token.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
