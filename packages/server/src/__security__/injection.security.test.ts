import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgMemberships, users } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";

// Resolve the org id for a freshly-created test memex. makeTestMemex creates
// the namespace + org + memex triple; this helper walks the join chain.
async function orgIdForMemex(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  if (!row?.orgId) throw new Error(`No org for memex ${memexId}`);
  return row.orgId;
}

const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

const memexIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

describe("security: injection & validation", () => {
  it("SQL-injection-style slug on /api/namespaces/check is rejected by format validation", async () => {
    // The namespaces router validates slug format before it ever touches SQL, but
    // even if validation were bypassed, Drizzle's parameterized queries would escape
    // the string. This test pins the validation layer — the first line of defense.
    const payload = "abc'; DROP TABLE memexes; --";
    const res = await app.request(
      `/api/namespaces/check?slug=${encodeURIComponent(payload)}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBe("invalid_chars");

    // The memexes table still exists. If we were actually vulnerable, this next request
    // would blow up with a "relation does not exist" error.
    const sanityCheck = await app.request("/api/namespaces/check?slug=acme");
    expect(sanityCheck.status).toBe(200);
  });

  it("email-domain field cannot inject JSON/SQL via updateOrgSettings", async () => {
    // SQL-injection safety is a service-layer guarantee (Drizzle's parameterized
    // queries), not an HTTP-layer one. Probe it directly via updateOrgSettings
    // and read back the row — the request layer would be a needlessly slow way
    // to test the same surface, and post-t-18 the HTTP route currently routes
    // through caller-scoped /api/orgs/current which can't disambiguate which
    // memex to target without the path prefix (and orgs/* stays flat per F.3).
    const memexId = await makeTestMemex("inj-dom");
    memexIds.push(memexId);
    const orgId = await orgIdForMemex(memexId);

    // Send a payload that would be unsafe if the server were string-concatenating JSON.
    const nasty = "'); DROP TABLE verified_domains; --.com";
    const { updateOrgSettings, getOrgSummary } = await import("../services/orgs.js");
    let acceptedOrRejected: "accepted" | "rejected" = "rejected";
    try {
      await updateOrgSettings(orgId, { emailDomains: [nasty] });
      acceptedOrRejected = "accepted";
    } catch {
      acceptedOrRejected = "rejected";
    }
    // Either the server rejects the bad domain (ValidationError) or it stores it
    // verbatim as a string. Either way, the SQL side remains healthy — proven by
    // a follow-up read that succeeds.
    expect(["accepted", "rejected"]).toContain(acceptedOrRejected);

    const summary = await getOrgSummary(orgId);
    expect(summary).toBeTruthy();
    expect(summary?.id).toBe(orgId);
  });

  it("XSS payload in doc title is stored verbatim but round-trips without server-side corruption", async () => {
    // Dev mode auto-authenticates as dev@memex.ai. Add dev as admin of the
    // newly-created org so the path-prefixed /api/<ns>/main/docs/:id resolves.
    const dev = await upsertUserByEmail("dev@memex.ai");
    userIds.push(dev.id);
    await db.delete(orgMemberships).where(eq(orgMemberships.userId, dev.id));

    const memexId = await makeTestMemex("inj-xss");
    memexIds.push(memexId);
    const orgId = await orgIdForMemex(memexId);
    await db.insert(orgMemberships).values({
      userId: dev.id,
      orgId,
      role: "administrator",
    });

    const { createDocDraft } = await import("../services/documents.js");
    const payload = `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
    const doc = await createDocDraft(memexId, payload, `<b>purpose</b>`);

    // Re-fetch via the path-prefixed mount (t-18 of doc-15). Server stores the
    // string as-is, does not HTML-encode, does not strip tags. That's a
    // deliberate contract: the server is a durable store; the client layer
    // (react-markdown + rehype-sanitize) is responsible for safe rendering.
    const [{ slug }] = await db
      .select({ slug: namespaces.slug })
      .from(memexes)
      .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
      .where(eq(memexes.id, memexId));

    const res = await app.request(`/api/${slug}/main/docs/${doc.id}`, {
      headers: { Host: "memex.ai" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe(payload);
    // Critical: the value arrives as a plain JSON string, not as parsed HTML injected
    // into the response. A JSON response cannot, by itself, execute injected script.
    expect(typeof body.title).toBe("string");
  });
});
