import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// b-31 W1 t-4 — the /mcp route accepts both `Bearer mxt_...` (existing) and
// OAuth JWTs (when OAUTH_ENABLED=1). This regression test pins the four
// branches of the prefix fork without booting the full MCP server: we mock
// the verifier modules + the MCP SDK so we can assert exactly which
// verifier was called and how the response was shaped.

const verifyMcpToken = vi.fn();
const bumpLastUsed = vi.fn();
const verifyAccessToken = vi.fn();
const createMcpServer = vi.fn(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/mcp-tokens.js", () => ({
  verifyMcpToken,
  bumpLastUsed,
}));
vi.mock("../services/oauth/access-tokens.js", () => ({
  verifyAccessToken,
}));
vi.mock("../mcp/tools.js", () => ({
  createMcpServer,
}));
vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    handleRequest = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
  },
}));
vi.mock("../mcp/migration-map.js", () => ({
  migrationErrorMessage: () => null,
}));
vi.mock("../db/connection.js", () => ({
  db: {},
}));

const originalFlag = process.env.OAUTH_ENABLED;

beforeEach(() => {
  verifyMcpToken.mockReset();
  bumpLastUsed.mockReset();
  verifyAccessToken.mockReset();
  createMcpServer.mockClear();
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalFlag;
  vi.resetModules();
});

async function postMcp(authHeader?: string): Promise<Response> {
  // Reset modules so OAUTH_ENABLED is read fresh per test.
  vi.resetModules();
  const { app } = await import("../app.js");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;
  return app.fetch(
    new Request("https://memex.ai/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
}

describe("regression: /mcp token-prefix fork (b-31 t-4)", () => {
  it("missing Authorization → 401, no verifier called", async () => {
    delete process.env.OAUTH_ENABLED;
    const res = await postMcp();
    expect(res.status).toBe(401);
    expect(verifyMcpToken).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("missing Authorization with OAUTH_ENABLED → 401 + WWW-Authenticate", async () => {
    process.env.OAUTH_ENABLED = "1";
    const res = await postMcp();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(
      /Bearer resource_metadata=.*\/\.well-known\/oauth-protected-resource/,
    );
  });

  it("mxt_ token → verifyMcpToken only, OAuth verifier untouched", async () => {
    delete process.env.OAUTH_ENABLED;
    verifyMcpToken.mockResolvedValue({ id: "tok-1", userId: "u-1" });
    const res = await postMcp("Bearer mxt_validtoken");
    expect(res.status).toBe(200);
    expect(verifyMcpToken).toHaveBeenCalledWith("mxt_validtoken");
    expect(bumpLastUsed).toHaveBeenCalledWith("tok-1");
    expect(verifyAccessToken).not.toHaveBeenCalled();
    // PAT path: orgFilter MUST be undefined (no Org-scope filter applied).
    // Third arg is the per-request Mcp-Session-Id (telemetry); always a string.
    expect(createMcpServer).toHaveBeenCalledWith("u-1", undefined, expect.any(String));
  });

  it("mxt_ token works even when OAUTH_ENABLED is on (coexistence)", async () => {
    process.env.OAUTH_ENABLED = "1";
    verifyMcpToken.mockResolvedValue({ id: "tok-2", userId: "u-2" });
    const res = await postMcp("Bearer mxt_alsovalid");
    expect(res.status).toBe(200);
    expect(verifyMcpToken).toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
    // mxt_ STILL passes orgFilter=undefined even when OAuth is enabled.
    expect(createMcpServer).toHaveBeenCalledWith("u-2", undefined, expect.any(String));
  });

  it("OAuth JWT with OAUTH_ENABLED off → 401, mxt_ error shape (no leak)", async () => {
    delete process.env.OAUTH_ENABLED;
    const res = await postMcp("Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    // Critically: returns the SAME message as mxt_-invalid so a probe can't
    // detect that OAuth is implemented but disabled in this deployment.
    expect(body.error).toBe("Invalid or revoked MCP token");
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("OAuth JWT with OAUTH_ENABLED on → verifyAccessToken; userId comes from claims.sub, claims.org flows through (b-31 dec-8)", async () => {
    process.env.OAUTH_ENABLED = "1";
    verifyAccessToken.mockReturnValue({
      sub: "u-3",
      iss: "memex-oauth",
      aud: "memex-mcp",
      client_id: "c-1",
      org: "org-acme",
      scope: "memex.full",
      iat: 1,
      exp: 9999999999,
    });
    const res = await postMcp("Bearer eyJ.something.valid");
    expect(res.status).toBe(200);
    expect(verifyMcpToken).not.toHaveBeenCalled();
    expect(verifyAccessToken).toHaveBeenCalledWith("eyJ.something.valid");
    // OAuth path: claims.org becomes the orgFilter — Org-scope filter is on.
    expect(createMcpServer).toHaveBeenCalledWith("u-3", "org-acme", expect.any(String));
  });

  it("OAuth JWT with org=null (personal-only grant) passes orgFilter=null", async () => {
    process.env.OAUTH_ENABLED = "1";
    verifyAccessToken.mockReturnValue({
      sub: "u-4",
      iss: "memex-oauth",
      aud: "memex-mcp",
      client_id: "c-1",
      org: null,
      scope: "memex.full",
      iat: 1,
      exp: 9999999999,
    });
    const res = await postMcp("Bearer eyJ.personal.only");
    expect(res.status).toBe(200);
    // Critical distinction: null !== undefined. Personal-only OAuth tokens
    // get orgFilter=null (which scopes to personal Memex only); PAT tokens
    // get orgFilter=undefined (full surface).
    expect(createMcpServer).toHaveBeenCalledWith("u-4", null, expect.any(String));
  });

  it("invalid OAuth JWT → 401 + WWW-Authenticate with error=invalid_token", async () => {
    process.env.OAUTH_ENABLED = "1";
    verifyAccessToken.mockImplementation(() => {
      throw new Error("signature mismatch");
    });
    const res = await postMcp("Bearer eyJ.bad.signature");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/error="invalid_token"/);
  });

  it("invalid mxt_ token never falls through to the OAuth path", async () => {
    process.env.OAUTH_ENABLED = "1";
    verifyMcpToken.mockResolvedValue(null);
    const res = await postMcp("Bearer mxt_revokedtoken");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid or revoked MCP token");
    // CRITICAL: mxt_-invalid must NOT silently retry as an OAuth token.
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});
