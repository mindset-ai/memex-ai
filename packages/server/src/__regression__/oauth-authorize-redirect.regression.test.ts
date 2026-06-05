import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pins the absolute-Location contract on GET /api/oauth/authorize.
//
// The c-32 / Barrie-87550be bug class: a relative `/oauth/authorize?<qs>`
// redirect stays on the API host (int-mcp.memex.ai on int, /mcp on prod)
// which doesn't serve the React consent page → 404. Fix was to issue an
// absolute URL via buildAppBaseUrl(). This regression catches a revert to
// the relative form, plus any drift that drops the query string or routes
// to a host that isn't APP_BASE_URL's origin.

const getClientByClientId = vi.fn();

vi.mock("../services/oauth/clients.js", () => ({
  getClientByClientId,
}));
vi.mock("../db/connection.js", () => ({
  db: {},
}));

const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalOauthEnabled = process.env.OAUTH_ENABLED;

beforeEach(() => {
  getClientByClientId.mockReset();
  process.env.OAUTH_ENABLED = "1";
});

afterEach(() => {
  if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalAppBaseUrl;
  if (originalOauthEnabled === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalOauthEnabled;
  vi.resetModules();
});

const VALID_QS = new URLSearchParams({
  response_type: "code",
  client_id: "test-client",
  redirect_uri: "https://test.example/cb",
  code_challenge: "abc123",
  code_challenge_method: "S256",
  state: "xyz",
}).toString();

async function getAuthorize(opts: { host: string } = { host: "int-mcp.memex.ai" }): Promise<Response> {
  vi.resetModules();
  const { app } = await import("../app.js");
  return app.fetch(
    new Request(`https://${opts.host}/api/oauth/authorize?${VALID_QS}`, {
      method: "GET",
    }),
  );
}

function stubClient() {
  getClientByClientId.mockResolvedValue({
    id: "client-row-uuid",
    clientId: "test-client",
    clientName: "Test client",
    redirectUris: ["https://test.example/cb"],
  });
}

describe("regression: GET /api/oauth/authorize Location header (b-31 c-32 / 87550be)", () => {
  it("issues 302 with an absolute Location URL (https://...) — never a relative /oauth/authorize", async () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    stubClient();

    const res = await getAuthorize();
    expect(res.status).toBe(302);

    const loc = res.headers.get("Location");
    expect(loc).toBeTruthy();
    // The Barrie-87550be class of bug — a relative redirect — would
    // produce `/oauth/authorize?...`. Pin the absolute form.
    expect(loc!.startsWith("/")).toBe(false);
    expect(loc).toMatch(/^https?:\/\//);
  });

  it("Location origin tracks APP_BASE_URL — int example", async () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    stubClient();

    const res = await getAuthorize({ host: "int-mcp.memex.ai" });
    const loc = res.headers.get("Location")!;

    expect(new URL(loc).origin).toBe("https://int.memex.ai");
    expect(new URL(loc).pathname).toBe("/oauth/authorize");
  });

  it("Location origin tracks APP_BASE_URL — prod example (memex.ai)", async () => {
    process.env.APP_BASE_URL = "https://memex.ai";
    stubClient();

    const res = await getAuthorize({ host: "memex.ai" });
    const loc = res.headers.get("Location")!;

    expect(new URL(loc).origin).toBe("https://memex.ai");
    expect(new URL(loc).pathname).toBe("/oauth/authorize");
  });

  it("Location origin tracks APP_BASE_URL — dev fallback (localhost:5173)", async () => {
    delete process.env.APP_BASE_URL;
    stubClient();

    const res = await getAuthorize({ host: "localhost:8080" });
    const loc = res.headers.get("Location")!;

    expect(new URL(loc).origin).toBe("http://localhost:5173");
    expect(new URL(loc).pathname).toBe("/oauth/authorize");
  });

  it("preserves the full query string on the redirect", async () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    stubClient();

    const res = await getAuthorize();
    const loc = new URL(res.headers.get("Location")!);

    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("test-client");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://test.example/cb");
    expect(loc.searchParams.get("code_challenge")).toBe("abc123");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBe("xyz");
  });
});

// b-31 t-37: RFC 8252 §7.3 requires the authorization server to accept any
// port on loopback redirect_uri at request time. Clients like Claude Code bind
// ephemeral localhost ports per session — the registered URI's port is
// effectively a placeholder. This block pins the loopback flexibility and
// asserts non-loopback URIs still strict-match.

function stubClientWithRedirect(redirectUri: string) {
  getClientByClientId.mockResolvedValue({
    id: "client-row-uuid",
    clientId: "test-client",
    clientName: "Test client",
    redirectUris: [redirectUri],
  });
}

async function getAuthorizeWithRedirect(redirectUri: string): Promise<Response> {
  vi.resetModules();
  const { app } = await import("../app.js");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: "test-client",
    redirect_uri: redirectUri,
    code_challenge: "abc123",
    code_challenge_method: "S256",
    state: "xyz",
  }).toString();
  return app.fetch(
    new Request(`https://int-mcp.memex.ai/api/oauth/authorize?${qs}`, { method: "GET" }),
  );
}

describe("regression: GET /api/oauth/authorize loopback redirect_uri port flexibility (b-31 t-37, RFC 8252 §7.3)", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
  });

  it("loopback: registered localhost:11111 matches incoming localhost:22222 (different port)", async () => {
    stubClientWithRedirect("http://localhost:11111/callback");
    const res = await getAuthorizeWithRedirect("http://localhost:22222/callback");
    expect(res.status).toBe(302);
  });

  it("loopback: registered localhost matches incoming 127.0.0.1 (hostname swap)", async () => {
    stubClientWithRedirect("http://localhost:11111/callback");
    const res = await getAuthorizeWithRedirect("http://127.0.0.1:33333/callback");
    expect(res.status).toBe(302);
  });

  it("loopback: rejects different path even when host matches", async () => {
    stubClientWithRedirect("http://localhost:11111/callback");
    const res = await getAuthorizeWithRedirect("http://localhost:22222/other");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_request",
      error_description: "redirect_uri not registered for this client",
    });
  });

  it("loopback: rejects different scheme (http registered, https requested)", async () => {
    stubClientWithRedirect("http://localhost:11111/callback");
    const res = await getAuthorizeWithRedirect("https://localhost:22222/callback");
    expect(res.status).toBe(400);
  });

  it("loopback: rejects non-loopback host with matching path/port", async () => {
    stubClientWithRedirect("http://localhost:11111/callback");
    const res = await getAuthorizeWithRedirect("http://attacker.com:11111/callback");
    expect(res.status).toBe(400);
  });

  it("non-loopback: https://example.com/cb does NOT match https://example.com:8443/cb (no port flexibility outside loopback)", async () => {
    stubClientWithRedirect("https://example.com/cb");
    const res = await getAuthorizeWithRedirect("https://example.com:8443/cb");
    expect(res.status).toBe(400);
  });

  it("non-loopback: strict exact-match still works (https registered = https requested)", async () => {
    stubClientWithRedirect("https://test.example/cb");
    const res = await getAuthorizeWithRedirect("https://test.example/cb");
    expect(res.status).toBe(302);
  });
});
