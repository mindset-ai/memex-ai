// spec-172 ac-8 — the env-gated test-only router (routes/__test__.ts) is the
// e2e suite's seed/cleanup/read surface. The AC has two halves, and this file
// proves both:
//
//   1. STATIC: every handler is backed by the server's REAL services — no raw
//      SQL string lives in the router (no `sql`...`` tagged template, no
//      `db.execute(` of a string). A schema move therefore breaks the SERVER
//      compile (the services it calls are typed against the live schema) or
//      returns a 4xx — it can't rot silently the way the old raw-SQL e2e
//      helpers did. The scan also asserts the handler bodies reach for the
//      imported service functions (createDocDraft, createDecision,
//      createOrgWithOwner via the seed-org helper, addSection, etc.).
//
//   2. RUNTIME: the core seed endpoints, driven over HTTP against a real test
//      DB, emit on the unified bus [per std-8]. We mount the router on a bare
//      Hono app (importing it directly, same as share.integration.test.ts) and
//      subscribe to the bus while the seed runs.
//
// Prior art for the static half: __regression__/mutate-coverage.static-scan.test.ts.
// Prior art for the runtime/bus half: __regression__/mutate-coverage.runtime.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { testOnlyRouter } from "./__test__.js";
import { errorHandler } from "../middleware/error-handler.js";
import { db } from "../db/connection.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { namespaces, orgs, memexes, orgMemberships, documents } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";

const AC = "mindset-prod/memex-building-itself/specs/spec-172/acs";

const ROUTER_SRC = join(__dirname, "__test__.ts");

// ── static half ─────────────────────────────────────────────────────────────

describe("spec-172 ac-8 (static): the test-only router calls real services, no raw SQL", () => {
  const raw = readFileSync(ROUTER_SRC, "utf8");

  it("contains no raw SQL — no `sql`...`` tagged template and no db.execute(...)", () => {
    tagAc(`${AC}/ac-8`);
    // A drizzle `sql` tagged template (sql`SELECT ...`) or a db.execute(...) of a
    // string is exactly the raw-SQL escape hatch the rebuild eliminated (dec-2):
    // it bypasses the typed services and rots silently when the schema moves.
    // Neither must appear in the router.
    expect(raw, "router must not use the drizzle `sql` tagged template").not.toMatch(
      /\bsql`/,
    );
    expect(raw, "router must not call db.execute()").not.toMatch(/\bdb\s*\.\s*execute\s*\(/);
    // Also reject importing the `sql` helper at all — its presence would be the
    // first sign a raw query crept in.
    expect(raw, "router must not import the drizzle `sql` helper").not.toMatch(
      /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*["']drizzle-orm["']/,
    );
  });

  it("every mutating seed endpoint delegates to an imported services/* function", () => {
    tagAc(`${AC}/ac-8`);
    // The router imports its mutators from services/* (and the test-only
    // seed-org helper, which itself calls createOrgWithOwner). Assert the
    // file imports from the services layer and that the seed handlers actually
    // invoke those service functions — not a hand-rolled DB write.
    expect(raw).toMatch(/from\s+["']\.\.\/services\//);

    // Each core seed endpoint must call its backing service by name. This pins
    // the "backed by real services" contract per endpoint rather than trusting
    // the import list alone.
    const requiredCalls = [
      "upsertUserByEmail", // /ensure-user
      "createOrgWithMemexForUser", // /seed-org (-> createOrgWithOwner)
      "createDocDraft", // /seed-spec, /seed-doc
      "createDecision", // /seed-open-decision
      "addSection", // /seed-section, /seed-doc (standard)
      "createTask", // /seed-execution-plan
      "createShareToken", // /seed-share-token
    ];
    for (const fn of requiredCalls) {
      expect(raw, `router must call services function ${fn}()`).toMatch(
        new RegExp(`\\b${fn}\\s*\\(`),
      );
    }
  });

  it("tenant-content seeds go through services; the only direct insert is the non-tenancy org_membership grant", () => {
    tagAc(`${AC}/ac-8`);
    // The router contains a few direct writes BY DESIGN: the /doc/:id hard-delete
    // is wrapped in mutate() so the deletion emits on the bus [per std-8]; the
    // /cleanup tear-down deletes raw (best-effort teardown); /org-add-member
    // inserts an org_membership row, which is non-tenancy access-control bootstrap
    // (no memex_id, no bus entity — the same category the static-scan allowlist
    // exempts). What must NOT exist is a raw insert that SEEDS TENANT CONTENT
    // (documents / doc_sections / decisions / tasks / comments) — those always
    // flow through a service so the row is schema-current and lands on the bus.
    const tenantTables = [
      "documents",
      "docSections",
      "decisions",
      "tasks",
      "docComments",
      "executionPlans",
      "shareTokens",
    ];
    for (const table of tenantTables) {
      expect(
        raw,
        `router must not raw-insert tenant content (${table}); seed via a service`,
      ).not.toMatch(new RegExp(`\\bdb\\s*\\.\\s*insert\\s*\\(\\s*${table}\\b`));
    }
    // The only direct db.insert in the router is the org_membership grant.
    const inserts = raw.match(/\bdb\s*\.\s*insert\s*\(\s*(\w+)/g) ?? [];
    expect(
      inserts.every((m) => /orgMemberships/.test(m)),
      `the only permitted raw insert is org_membership; found: ${JSON.stringify(inserts)}`,
    ).toBe(true);
    // The hard-delete IS wrapped in mutate() — sanity-check the wrapper is present
    // so the bus-emitting delete path is real.
    expect(raw).toMatch(/\bmutate\s*\(/);
  });
});

// ── runtime / bus half ──────────────────────────────────────────────────────

const app = new Hono();
app.onError(errorHandler);
app.route("/api/__test__", testOnlyRouter);

const createdNamespaceSlugs: string[] = [];
const createdDocIds: string[] = [];

beforeAll(async () => {
  // Ensure the dev user (the e2e default actor) exists with a personal namespace.
  const dev = await upsertUserByEmail("dev@memex.ai");
  await ensureUserNamespace(dev.id);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  for (const slug of createdNamespaceSlugs) {
    const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.slug, slug) });
    if (!ns) continue;
    const memexIds = (
      await db.select({ id: memexes.id }).from(memexes).where(eq(memexes.namespaceId, ns.id))
    ).map((r) => r.id);
    for (const mxId of memexIds) {
      await db.delete(documents).where(eq(documents.memexId, mxId)).catch(() => {});
    }
    const orgIds = (
      await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.namespaceId, ns.id))
    ).map((r) => r.id);
    for (const orgId of orgIds) {
      await db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId)).catch(() => {});
    }
    await db.delete(memexes).where(eq(memexes.namespaceId, ns.id)).catch(() => {});
    await db.update(namespaces).set({ ownerOrgId: null }).where(eq(namespaces.id, ns.id)).catch(() => {});
    await db.delete(orgs).where(eq(orgs.namespaceId, ns.id)).catch(() => {});
    await db.delete(namespaces).where(eq(namespaces.id, ns.id)).catch(() => {});
  }
});

// Run `fn` while subscribing to every bus event, returning the captured events.
async function captureBus(fn: () => Promise<void>): Promise<ChangeEvent[]> {
  const seen: ChangeEvent[] = [];
  const unsubscribe = bus.subscribe({}, (e) => seen.push(e));
  try {
    await fn();
  } finally {
    unsubscribe();
  }
  return seen;
}

describe("spec-172 ac-8 (runtime): seed endpoints go through real services and emit on the bus", () => {
  it("POST /seed-org emits org-creation events on the unified bus [per std-8]", async () => {
    tagAc(`${AC}/ac-8`);
    const dev = await upsertUserByEmail("dev@memex.ai");
    const slug = `s172-ac8-org-${Date.now().toString(36)}`;
    createdNamespaceSlugs.push(slug);

    const events = await captureBus(async () => {
      const res = await app.request("/api/__test__/seed-org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerEmail: "dev@memex.ai", slug }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { orgId: string };
      expect(body.orgId).toBeTruthy();
    });

    // createOrgWithOwner (reached via the seed-org helper) emits org.created plus
    // user_namespace + org_membership — proving the seed flowed through the real
    // service, not a raw insert.
    const orgCreated = events.find((e) => e.entity === "org" && e.action === "created");
    expect(
      orgCreated,
      `seed-org did not emit org.created. Saw: ${JSON.stringify(
        events.map((e) => ({ entity: e.entity, action: e.action })),
      )}`,
    ).toBeDefined();
    void dev;
  });

  it("POST /seed-spec emits document.created on the unified bus [per std-8]", async () => {
    tagAc(`${AC}/ac-8`);
    const { memexId, slug } = await makeTestMemexWithDevAdmin("s172ac8");
    createdNamespaceSlugs.push(slug);

    let docId = "";
    const events = await captureBus(async () => {
      const res = await app.request("/api/__test__/seed-spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memexId, title: "AC-8 seeded spec" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docId: string };
      docId = body.docId;
      createdDocIds.push(body.docId);
    });

    const docCreated = events.find(
      (e) => e.entity === "document" && e.action === "created" && e.docId === docId,
    );
    expect(
      docCreated,
      `seed-spec did not emit document.created for the seeded doc. Saw: ${JSON.stringify(
        events.map((e) => ({ entity: e.entity, action: e.action, docId: e.docId })),
      )}`,
    ).toBeDefined();
  });

  it("POST /ensure-user goes through the real upsert service and 200s", async () => {
    tagAc(`${AC}/ac-8`);
    // ensure-user is identity provisioning (users table has no bus entity by
    // design — std-8 §6), so the proof here is that it delegates to the real
    // upsertUserByEmail/ensureUserNamespace services and returns a live userId,
    // not a raw insert.
    const res = await app.request("/api/__test__/ensure-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dev@memex.ai" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; userId: string };
    expect(body.ok).toBe(true);
    expect(body.userId).toBeTruthy();
  });
});
