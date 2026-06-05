// End-to-end tests for the /mcp HTTP endpoint with bearer token auth. Spins up the
// real Hono app and exercises the auth path + a couple of representative tool calls.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  users,
  mcpTokens,
} from "../db/schema.js";
import { mintMcpToken, revokeMcpToken } from "../services/mcp-tokens.js";

// Force dev mode so sessionMiddleware (used by other routes the app mounts) doesn't
// fail. /mcp itself doesn't depend on it.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

const created = {
  users: [] as string[],
  memexes: [] as string[],
};

afterAll(async () => {
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
});

async function setup(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-e2e-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  // doc-15 t-11: namespace + org + memex tuple replaces the legacy `accounts` row.
  const slug = `${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`.toLowerCase().slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" } as any).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: suffix } as any).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: suffix, slug: "main", namespaceId: ns.id } as any)
    .returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
  // Surface a subdomain shim so existing assertions (`account.slug`) keep
  // referencing the namespace slug.
  return { user: u, account: { ...a, slug: ns.slug } };
}

async function mcpRequest(token: string | null, body: unknown) {
  const { app } = await import("../app.js");
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message?: string } } {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data in response: ${text}`);
  return JSON.parse(dataLine.slice(6));
}

describe("/mcp endpoint", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await mcpRequest(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_memexes", arguments: {} },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Authorization/);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await mcpRequest("mxt_invalid_token_value_xxx", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_memexes", arguments: {} },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("token_invalid");
  });

  it("returns 401 for a revoked token", async () => {
    const { user } = await setup("revoked");
    const { raw, row } = await mintMcpToken(user.id, "TestDevice");
    await revokeMcpToken(row.id, user.id);

    const res = await mcpRequest(raw, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_memexes", arguments: {} },
    });
    expect(res.status).toBe(401);
  });

  it("list_memexes returns the user's memberships", async () => {
    const { user, account } = await setup("listws");
    const { raw } = await mintMcpToken(user.id, "TestDevice");

    const res = await mcpRequest(raw, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_memexes", arguments: {} },
    });
    expect(res.status).toBe(200);

    const body = parseSse(await res.text());
    expect(body.result?.content?.[0].text).toContain(account.slug);
    expect(body.result?.content?.[0].text).toContain("administrator");
  });

  it("create_doc resolves workspace from subdomain arg and creates the doc", async () => {
    const { user, account } = await setup("createdoc");
    const { raw } = await mintMcpToken(user.id, "TestDevice");

    const res = await mcpRequest(raw, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_doc",
        arguments: { workspace: account.slug, title: "MCP E2E Doc", purpose: "test" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.content?.[0].text).toContain("MCP E2E Doc");

    // Verify doc landed in the right account
    const docs = await db.query.documents.findMany({ where: (d, { eq }) => eq(d.memexId, account.id) });
    expect(docs.find((d) => d.title === "MCP E2E Doc")).toBeDefined();
  });

  it("create_doc auto-defaults workspace when user has only one", async () => {
    const { user } = await setup("solo");
    const { raw } = await mintMcpToken(user.id, "TestDevice");

    const res = await mcpRequest(raw, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_doc",
        arguments: { title: "Default WS Doc", purpose: "test" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.content?.[0].text).toContain("Default WS Doc");
  });

  it("get_doc forbids cross-account access", async () => {
    const owner = await setup("owner-x");
    const stranger = await setup("stranger-x");
    // b-36 T-6 / b-105: use a Spec docType so the canonical ref grammar
    // resolves through /specs/. The cross-account guard still trips before
    // the returned entity is exposed.
    const [doc] = await db
      .insert(documents)
      .values({
        memexId: owner.account.id,
        handle: "spec-1",
        title: "Owner's doc",
        docType: "spec",
      })
      .returning();

    const { raw } = await mintMcpToken(stranger.user.id, "TestDevice");
    const res = await mcpRequest(raw, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_doc",
        arguments: { ref: `${owner.account.slug}/main/specs/${doc.handle}` },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0].text).toMatch(/not a member/);
  });
});
