import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, mcpTokens } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";

// Covers the session-gated mint endpoint added for spec-304 t-10 (the desktop
// app's in-app "Install MCP" path): POST /api/mcp/tokens.
//   - ac-26: gated by sessionMiddleware — an unauthenticated POST is rejected,
//            no token minted.
//   - ac-27: an authenticated POST mints via mintMcpToken (through mutate per
//            std-8), returns the raw mxt_ token exactly once, and that token
//            authenticates against /mcp.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-304/acs/ac-${n}`;

// Force dev mode so sessionMiddleware uses the dev-user fallback (token-less
// requests auto-resolve dev@memex.ai). isDevMode() reads GOOGLE_CLIENT_ID per
// request, so the ac-26 test can flip it back on to exercise the real 401 path.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});

const createdLabels: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (createdLabels.length) {
    await db.delete(mcpTokens).where(inArray(mcpTokens.label, createdLabels)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function appReq(path: string, init: RequestInit = {}) {
  const { app } = await import("../app.js");
  return app.request(path, init);
}

describe("POST /api/mcp/tokens — session gating (ac-26)", () => {
  it("rejects an unauthenticated request with 401 and mints no token", async () => {
    tagAc(AC(26));
    // Take GOOGLE_CLIENT_ID off the dev-mode path so sessionMiddleware enforces
    // a real Bearer (NODE_ENV is "test", not "production", so isDevMode() simply
    // returns false rather than throwing).
    const prev = process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = "test-client-id-for-session-gating";
    const label = `unauth-should-not-mint-${Date.now()}`;
    try {
      const res = await appReq("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = prev;
    }

    // The request never reached the handler, so nothing was inserted.
    const rows = await db.query.mcpTokens.findMany({ where: eq(mcpTokens.label, label) });
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/mcp/tokens — authenticated mint (ac-27)", () => {
  it("mints a token, returns the raw mxt_ secret once, and it authenticates against /mcp", async () => {
    tagAc(AC(27));
    const devUser = await upsertUserByEmail("dev@memex.ai");
    if (!createdUserIds.includes(devUser.id)) createdUserIds.push(devUser.id);

    const label = `MintTest-${Date.now()}`;
    createdLabels.push(label);

    const res = await appReq("/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    // The raw mxt_ token is present exactly here, in the mint response.
    expect(body.token).toMatch(/^mxt_/);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.label).toBe(label);
    expect(body.prefix.startsWith("mxt_")).toBe(true);
    const raw: string = body.token;

    // ...and only here: the settings list returns safe metadata, never the raw
    // token or its hash.
    const list = await appReq("/api/mcp/tokens");
    const tokens: Array<Record<string, unknown>> = await list.json();
    const minted = tokens.find((t) => t.id === body.id);
    expect(minted).toBeDefined();
    expect(minted).toHaveProperty("prefix");
    expect(minted).not.toHaveProperty("token");
    expect(minted).not.toHaveProperty("tokenHash");

    // The minted raw token authenticates against /mcp: contrast a real token
    // (which passes the verifyMcpToken gate — anything but a token_invalid 401)
    // with a bogus mxt_ token (which is rejected). Don't read the streaming body
    // on the success path — only the status matters for the auth assertion.
    const mcpInit = (bearer: string) =>
      appReq("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "spec-304-test", version: "0" },
          },
        }),
      });

    const accepted = await mcpInit(raw);
    expect(accepted.status).not.toBe(401);

    const rejected = await mcpInit("mxt_definitely-not-a-real-token");
    expect(rejected.status).toBe(401);
    const rejectedBody = await rejected.json();
    expect(rejectedBody.code).toBe("token_invalid");
  });

  it("defaults the label to \"Memex Desktop\" when none is supplied", async () => {
    tagAc(AC(27));
    createdLabels.push("Memex Desktop");
    const res = await appReq("/api/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.label).toBe("Memex Desktop");
    expect(body.token).toMatch(/^mxt_/);
  });
});
