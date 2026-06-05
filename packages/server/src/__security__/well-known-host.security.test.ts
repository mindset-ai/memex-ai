import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// b-31 t-23: the OAuth discovery documents at
// `/.well-known/oauth-authorization-server` and
// `/.well-known/oauth-protected-resource` are reachable without auth and are
// what every MCP client trusts to learn where to send /authorize and /token.
//
// `publicBaseUrl` used to read `X-Forwarded-Host` unconditionally, but
// `hostGuard` only validates `Host`. So a request like:
//
//   GET /.well-known/oauth-authorization-server
//   Host: memex.ai
//   X-Forwarded-Host: evil.com
//
// passed the host guard yet caused the discovery document to advertise
// `authorization_endpoint: https://evil.com/api/oauth/authorize` — a
// pre-auth, no-CSRF phishing primitive against every Memex MCP client.
//
// The fix: only honor X-Forwarded-Host when it strips down to a host already
// on the ALLOWED_HOSTS allowlist (the same set hostGuard enforces). This test
// pins the three cases.

// OAUTH_ENABLED must be set before app.ts is imported, because the
// /.well-known router is conditionally mounted at module load. vi.hoisted
// runs before any static import; combined with the lazy import inside
// getWellKnown(), this guarantees the flag is on when app.ts is first read.
const ORIGINAL_OAUTH_FLAG = vi.hoisted(() => {
  const prev = process.env.OAUTH_ENABLED;
  process.env.OAUTH_ENABLED = "1";
  return prev;
});

beforeAll(() => {
  // No-op: env was set in vi.hoisted above. Kept for symmetry with afterAll
  // and to document intent.
  process.env.OAUTH_ENABLED = "1";
});

afterAll(() => {
  if (ORIGINAL_OAUTH_FLAG === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = ORIGINAL_OAUTH_FLAG;
});

async function getWellKnown(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const { app } = await import("../app.js");
  // Cloud Run terminates TLS at the LB and sets X-Forwarded-Proto. Vitest
  // doesn't set NODE_ENV=production, so without this header `publicBaseUrl`
  // would default to `http://`. Pinning the proto here keeps the assertions
  // focused on the X-Forwarded-Host allowlist logic.
  const res = await app.fetch(
    new Request(`https://memex.ai${path}`, {
      method: "GET",
      headers: { "X-Forwarded-Proto": "https", ...headers },
    }),
  );
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw), raw };
}

describe("security: /.well-known/* respects allowlist for X-Forwarded-Host", () => {
  describe("/.well-known/oauth-authorization-server", () => {
    const path = "/.well-known/oauth-authorization-server";

    it("with only Host: memex.ai → advertises https://memex.ai/...", async () => {
      const { status, body } = await getWellKnown(path, {
        Host: "memex.ai",
      });
      expect(status).toBe(200);
      expect(body.issuer).toBe("https://memex.ai");
      expect(body.authorization_endpoint).toBe(
        "https://memex.ai/api/oauth/authorize",
      );
      expect(body.token_endpoint).toBe("https://memex.ai/api/oauth/token");
      expect(body.registration_endpoint).toBe(
        "https://memex.ai/api/oauth/register",
      );
    });

    it("ignores malicious X-Forwarded-Host: evil.com", async () => {
      const { status, body, raw } = await getWellKnown(path, {
        Host: "memex.ai",
        "X-Forwarded-Host": "evil.com",
      });
      expect(status).toBe(200);
      expect(body.issuer).toBe("https://memex.ai");
      expect(body.authorization_endpoint).toBe(
        "https://memex.ai/api/oauth/authorize",
      );
      // Belt-and-braces: the malicious host must not appear anywhere in the
      // body, not even in `service_documentation` or some future field.
      expect(raw).not.toContain("evil.com");
    });

    it("honors allowlisted X-Forwarded-Host: int.memex.ai", async () => {
      const { status, body } = await getWellKnown(path, {
        Host: "memex.ai",
        "X-Forwarded-Host": "int.memex.ai",
      });
      expect(status).toBe(200);
      expect(body.issuer).toBe("https://int.memex.ai");
      expect(body.authorization_endpoint).toBe(
        "https://int.memex.ai/api/oauth/authorize",
      );
    });
  });

  // Both shapes — root and per-resource (RFC 9728 §3.1) — share the same
  // handler and therefore the same X-Forwarded-Host allowlist behaviour, but
  // each path is its own route registration. Run the host-injection cases
  // against both to pin that registering a new variant in the future doesn't
  // accidentally skip the security check.
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    describe(path, () => {
      it("with only Host: memex.ai → advertises https://memex.ai/mcp", async () => {
        const { status, body } = await getWellKnown(path, {
          Host: "memex.ai",
        });
        expect(status).toBe(200);
        expect(body.resource).toBe("https://memex.ai/mcp");
        expect(body.authorization_servers).toEqual(["https://memex.ai"]);
      });

      it("ignores malicious X-Forwarded-Host: evil.com", async () => {
        const { status, body, raw } = await getWellKnown(path, {
          Host: "memex.ai",
          "X-Forwarded-Host": "evil.com",
        });
        expect(status).toBe(200);
        expect(body.resource).toBe("https://memex.ai/mcp");
        expect(body.authorization_servers).toEqual(["https://memex.ai"]);
        expect(raw).not.toContain("evil.com");
      });

      it("honors allowlisted X-Forwarded-Host: int.memex.ai", async () => {
        const { status, body } = await getWellKnown(path, {
          Host: "memex.ai",
          "X-Forwarded-Host": "int.memex.ai",
        });
        expect(status).toBe(200);
        expect(body.resource).toBe("https://int.memex.ai/mcp");
        expect(body.authorization_servers).toEqual(["https://int.memex.ai"]);
      });
    });
  }
});
