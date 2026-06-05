import { describe, it, expect, afterEach } from "vitest";
import { wellKnown } from "./well-known.js";

// Pure HTTP-shape unit tests — no DB. The OAuth flag gates visibility; the
// shape of the metadata documents must match RFC 8414 / draft-protected-resource
// so MCP clients can parse them. Anthropic's directory review checks for
// exactly these fields.

const originalFlag = process.env.OAUTH_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalFlag;
});

async function fetchAt(path: string, headers: Record<string, string> = {}) {
  process.env.OAUTH_ENABLED = "1";
  return wellKnown.fetch(
    new Request(`http://example.com${path}`, {
      // Mirror Cloud Run's edge — X-Forwarded-Proto=https so the issuer URL is https.
      headers: { Host: "memex.ai", "X-Forwarded-Proto": "https", ...headers },
    }),
  );
}

describe("well-known discovery", () => {
  it("OAuth Authorization Server metadata advertises the required RFC 8414 fields", async () => {
    const res = await fetchAt("/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("https://memex.ai");
    expect(body.authorization_endpoint).toBe("https://memex.ai/api/oauth/authorize");
    expect(body.token_endpoint).toBe("https://memex.ai/api/oauth/token");
    expect(body.registration_endpoint).toBe("https://memex.ai/api/oauth/register");
    expect(body.revocation_endpoint).toBe("https://memex.ai/api/oauth/revoke");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    // OAuth 2.1 requires S256-only at minimum; we advertise exactly that.
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.scopes_supported).toEqual(["memex.full"]);
  });

  it("Protected Resource metadata points clients at /mcp + the issuer", async () => {
    const res = await fetchAt("/oauth-protected-resource");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe("https://memex.ai/mcp");
    expect(body.authorization_servers).toEqual(["https://memex.ai"]);
    expect(body.scopes_supported).toEqual(["memex.full"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("per-resource variant /oauth-protected-resource/mcp returns the same body (RFC 9728 §3.1)", async () => {
    const root = await (await fetchAt("/oauth-protected-resource")).json();
    const perResource = await (await fetchAt("/oauth-protected-resource/mcp")).json();
    expect(perResource).toEqual(root);
  });

  it("falls back to the Host header when no X-Forwarded-Host", async () => {
    process.env.OAUTH_ENABLED = "1";
    const res = await wellKnown.fetch(
      new Request("http://example.com/oauth-authorization-server", {
        headers: { Host: "int.memex.ai" },
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    // NODE_ENV is not 'production' in tests → http scheme falls back.
    expect(body.issuer).toContain("int.memex.ai");
  });

  it("returns 404 when OAUTH_ENABLED is unset", async () => {
    delete process.env.OAUTH_ENABLED;
    const res = await wellKnown.fetch(
      new Request("http://example.com/oauth-authorization-server", {
        headers: { Host: "memex.ai" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
