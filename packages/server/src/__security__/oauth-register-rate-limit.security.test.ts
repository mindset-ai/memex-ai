// b-31 t-31 — IP-keyed rate-limit on POST /api/oauth/register.
//
// The DCR endpoint is anonymous per b-31 dec-7(a) — without rate-limiting any
// caller could flood oauth_clients. This test asserts:
//
//   1. 10 successive registrations from the same X-Forwarded-For are allowed.
//   2. The 11th from that IP returns 429 with a Retry-After header.
//   3. A request from a different X-Forwarded-For is unaffected (separate
//      bucket).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { oauthClients } from "../db/schema.js";
import { resetRateLimits } from "../services/auth-rate-limit.js";

const originalFlag = process.env.OAUTH_ENABLED;

beforeAll(() => {
  process.env.OAUTH_ENABLED = "1";
  // Clear the in-memory bucket store so prior tests don't pollute this one.
  resetRateLimits();
});

afterAll(() => {
  if (originalFlag === undefined) delete process.env.OAUTH_ENABLED;
  else process.env.OAUTH_ENABLED = originalFlag;
});

const createdClientIds: string[] = [];

afterAll(async () => {
  if (createdClientIds.length) {
    await db
      .delete(oauthClients)
      .where(inArray(oauthClients.clientId, createdClientIds))
      .catch(() => {});
  }
});

async function registerFromIp(ip: string, label: string): Promise<Response> {
  const { app } = await import("../app.js");
  return app.fetch(
    new Request("https://memex.ai/api/oauth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": ip,
      },
      body: JSON.stringify({
        client_name: label,
        redirect_uris: ["https://example.com/cb"],
      }),
    }),
  );
}

describe("security: POST /api/oauth/register rate-limit", () => {
  it("allows 10 registrations per hour per IP, blocks the 11th, isolates by IP", async () => {
    const ipA = "203.0.113.10"; // RFC 5737 documentation range
    const ipB = "203.0.113.11";

    // 1. Ten successive POSTs from ipA — every one should 201.
    for (let i = 0; i < 10; i++) {
      const res = await registerFromIp(ipA, `rate-limit-A-${i}`);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { client_id: string };
      createdClientIds.push(body.client_id);
    }

    // 2. The 11th from the same IP must be 429 with a Retry-After header.
    const blocked = await registerFromIp(ipA, "rate-limit-A-11");
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // 3. A different IP gets its own bucket — must still 201.
    const fromB = await registerFromIp(ipB, "rate-limit-B-1");
    expect(fromB.status).toBe(201);
    const bBody = (await fromB.json()) as { client_id: string };
    createdClientIds.push(bBody.client_id);
  });
});
