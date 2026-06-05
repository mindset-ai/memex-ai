// Layer A regression guard for std-2: every URL the server emits for a tenant
// resource has the shape `<HOST>/<namespace>/<memex>/...`, where `<HOST>` is
// the origin of `APP_BASE_URL`. Host-agnostic — adding a new env (e.g. an EU
// region) MUST NOT require a code change here.
//
// This complements `__e2e__/path-routing.api.test.ts` (which asserts the
// server REJECTS subdomain hostnames). This file asserts the server EMITS
// path-based URLs.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  if (created.docs.length) {
    await db
      .delete(documents)
      .where(inArray(documents.id, created.docs))
      .catch(() => {});
  }
  if (created.memexes.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, created.memexes))
      .catch(() => {});
  }
  if (created.users.length) {
    await db
      .delete(users)
      .where(inArray(users.id, created.users))
      .catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [u] = await db
    .insert(users)
    .values({ email: `url-shape-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: sub, kind: "org" } as any)
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` } as any)
    .returning();
  await db
    .update(namespaces)
    .set({ ownerOrgId: org.id })
    .where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: `Test ${sub}`, slug: "main", namespaceId: ns.id } as any)
    .returning();
  created.memexes.push(a.id);
  await db
    .insert(orgMemberships)
    .values({ userId: u.id, orgId: org.id, role: "administrator" } as any);
  return {
    user: u,
    namespaceSlug: ns.slug,
    memexSlug: "main",
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredToolLike {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, RegisteredToolLike>;
    }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler({ ...args, verbose: true }, {} as unknown);
}

// Parameterised: each entry exercises a different APP_BASE_URL value. The
// fictional `eu.memex.ai` is included specifically to prove the test (and the
// builder it covers) are host-agnostic — adding a new env shouldn't break
// either.
const APP_BASE_URLS = [
  "https://int.memex.ai",
  "https://memex.ai",
  "https://eu.memex.ai",
];

describe("URL-shape regression (std-2)", () => {
  let originalAppBaseUrl: string | undefined;
  let actor: Awaited<ReturnType<typeof setupActor>>;

  beforeAll(async () => {
    originalAppBaseUrl = process.env.APP_BASE_URL;
    actor = await setupActor("urlshape");
  });

  afterAll(() => {
    if (originalAppBaseUrl !== undefined) {
      process.env.APP_BASE_URL = originalAppBaseUrl;
    } else {
      delete process.env.APP_BASE_URL;
    }
  });

  for (const appBaseUrl of APP_BASE_URLS) {
    describe(`APP_BASE_URL=${appBaseUrl}`, () => {
      beforeEach(() => {
        process.env.APP_BASE_URL = appBaseUrl;
      });

      it("create_doc emits a URL starting with ${expectedOrigin}/<ns>/<mx>/", async () => {
        const expectedOrigin = new URL(appBaseUrl).origin;

        const result = await callTool(actor.user.id, "create_doc", {
          memex: `${actor.namespaceSlug}/${actor.memexSlug}`,
          title: `URL shape ${appBaseUrl}`,
          purpose: "Regression guard for std-2",
          docType: "spec",
        });
        expect(result.isError).toBeFalsy();

        // Extract the URL from the response (verbose includes a `URL: ...` line).
        const text = result.content[0].text;
        const urlMatch = text.match(/URL:\s*(\S+)/);
        expect(urlMatch).not.toBeNull();
        const emittedUrl = urlMatch![1];

        const parsed = new URL(emittedUrl);

        // Host equals the configured origin's host — no subdomain prefixing.
        expect(`${parsed.protocol}//${parsed.host}`).toBe(expectedOrigin);

        // Path starts with /<namespace>/<memex>/.
        const expectedPathPrefix = `/${actor.namespaceSlug}/${actor.memexSlug}/`;
        expect(parsed.pathname.startsWith(expectedPathPrefix)).toBe(true);

        // Sanity: no `${slug}.${host}` pattern leaked anywhere into the host.
        // The configured host MUST be the literal substring at the start.
        expect(emittedUrl.startsWith(`${expectedOrigin}/`)).toBe(true);

        // Track the created doc for cleanup.
        const idMatch = text.match(/UUID:\s*([0-9a-f-]+)/i);
        if (idMatch) created.docs.push(idMatch[1]);
      });
    });
  }
});
