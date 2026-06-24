// spec-199 security hardening — non-member redaction + share-token revocation,
// verified at the server boundary over real HTTP (app.request).
//
// RELOCATED from the e2e suite (spec-393, workstream D of spec-388). These three
// cases were `journey-22-spec-199-security.spec.ts` — but every one used
// Playwright's `request.get` (the APIRequestContext), never the browser page, so
// they were paying e2e cost (cold DB, browser boot, the serial long pole) to
// assert pure server behaviour. They belong here: faster, and they free the e2e
// long pole. The browser-level isolation coverage now lives in the std-7 404
// journey (spec-393 dec-1). [per std-7] [per std-28 — relocation, not deletion]
//
// They keep tagging the SAME spec-199 ACs (ac-1/ac-3/ac-6) so that verification
// signal survives the move intact.
//
// Dev-mode auth note (same posture as cross-account.security.test.ts):
// GOOGLE_CLIENT_ID is unset → sessionMiddleware auto-authenticates every
// token-less request as dev@memex.ai. dev is NOT a member of the seeded org, so
// publicSessionMiddleware leaves the caller a non-member on a public memex —
// exactly the redaction path under test. The one case that needs dev to act
// (member removal) adds dev as a second admin first so the last-admin guard
// passes.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, orgMemberships, users } from "../db/schema.js";
import { app } from "../app.js";
import { upsertUserByEmail } from "../services/users.js";
import { createOrgWithMemexForUser } from "../services/__test__/seed-org.js";
import { createDocDraft } from "../services/documents.js";
import { updateMemexVisibility } from "../services/memexes.js";
import { assign } from "../services/doc-assignees.js";
import { createShareToken } from "../services/share-tokens.js";
import { disableMembership } from "../services/org-memberships.js";
import { persistEvent } from "../services/activity-log.js";

// spec-199 ac-1 — email is never leaked to a non-member on a public memex.
const AC1 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-1";
// spec-199 ac-3 — removing a member bulk-revokes their share tokens (replay 410).
const AC3 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-3";
// spec-199 ac-6 — the activity endpoint redacts actorUserId/clientId/payload for a non-member.
const AC6 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-6";

const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

// Track everything we create so the per-worker DB clone stays clean (std-37).
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

// A per-call-unique slug combining worker id and high-entropy randomness so
// parallel workers never collide on the namespace UNIQUE constraint (std-37).
function uniqueSlug(prefix: string): string {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${worker}-${rand}`;
}

interface Seeded {
  orgId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexId: string;
  ownerId: string;
  docId: string;
}

// Seed an org + memex owned by `owner`, a spec in it, and make the memex public.
// `owner` is a non-dev user, so dev@memex.ai (the auto-authed caller) probes it
// as a NON-MEMBER of a PUBLIC memex — the redaction path.
async function seedPublicMemexWithSpec(prefix: string): Promise<Seeded> {
  const owner = await upsertUserByEmail(`${uniqueSlug(prefix)}@example.com`);
  userIds.push(owner.id);

  const seeded = await createOrgWithMemexForUser({
    slug: uniqueSlug(prefix),
    userId: owner.id,
  });
  memexIds.push(seeded.memex.id);

  await updateMemexVisibility(seeded.memex.id, "public");

  const doc = await createDocDraft(
    seeded.memex.id,
    `${prefix} redaction spec`,
    "private detail",
    "spec",
    undefined,
    undefined,
    owner.id,
  );

  return {
    orgId: seeded.org.id,
    namespaceSlug: seeded.namespace.slug,
    memexSlug: seeded.memex.slug,
    memexId: seeded.memex.id,
    ownerId: owner.id,
    docId: doc.id,
  };
}

function tenantPath(ns: string, mx: string, suffix: string): string {
  return `/api/${ns}/${mx}${suffix}`;
}

describe("security: spec-199 non-member redaction + share-token revocation", () => {
  // ── ac-1: email redaction on the non-member path ───────────────────────────
  it("doc-members and doc-assignees return email:null for a non-member on a public memex", async () => {
    tagAc(AC1);
    const s = await seedPublicMemexWithSpec("sec199-j1");
    // The owner is an editor; assign them so doc-assignees has a row to redact.
    await assign(s.memexId, s.docId, s.ownerId, null);

    // dev@memex.ai is NOT a member of the seeded org → isMember=false → email stripped.
    const membersRes = await app.request(
      tenantPath(s.namespaceSlug, s.memexSlug, `/doc-members/doc/${s.docId}`),
      { headers: { Host: "memex.ai" } },
    );
    expect(membersRes.status).toBe(200);
    const members = (await membersRes.json()) as { editors: Array<{ email: string | null }> };
    expect(members.editors.length).toBeGreaterThan(0);
    for (const editor of members.editors) {
      expect(editor.email).toBeNull();
    }

    const assigneesRes = await app.request(
      tenantPath(s.namespaceSlug, s.memexSlug, `/doc-assignees/doc/${s.docId}`),
      { headers: { Host: "memex.ai" } },
    );
    expect(assigneesRes.status).toBe(200);
    const assignees = (await assigneesRes.json()) as Array<{ email: string | null }>;
    expect(assignees.length).toBeGreaterThan(0);
    for (const assignee of assignees) {
      expect(assignee.email).toBeNull();
    }
  });

  // ── ac-3: removing a member bulk-revokes their share tokens ────────────────
  it("removing a member bulk-revokes their share tokens — replay returns 410", async () => {
    tagAc(AC3);
    const s = await seedPublicMemexWithSpec("sec199-j2");

    // Mint a share token attributed to the owner so disableMembership bulk-revokes it.
    const tok = await createShareToken(s.memexId, s.docId, s.ownerId);

    // Sanity: the token is valid before revocation.
    const before = await app.request(`/api/share/${tok.token}`, {
      headers: { Host: "memex.ai" },
    });
    expect(before.status).toBe(200);

    // Add dev as a second admin so the last-admin guard passes when the owner is
    // disabled, then act as dev to disable the owner → bulk-revoke fires.
    const dev = await upsertUserByEmail("dev@memex.ai");
    userIds.push(dev.id);
    await db.insert(orgMemberships).values({
      userId: dev.id,
      orgId: s.orgId,
      role: "administrator",
    });
    await disableMembership(s.ownerId, s.orgId, dev.id);

    // The revoked token now returns 410 Gone (share.ts: err.reason === "revoked").
    const after = await app.request(`/api/share/${tok.token}`, {
      headers: { Host: "memex.ai" },
    });
    expect(after.status).toBe(410);
  });

  // ── ac-6: activity column redaction on the non-member path ─────────────────
  it("activity endpoint omits actorUserId, clientId, payload for a non-member on a public memex", async () => {
    tagAc(AC6);
    const s = await seedPublicMemexWithSpec("sec199-j3");

    // Plant a row with all three sensitive fields set — otherwise the loop below
    // is vacuously true on an empty activity list.
    const row = await persistEvent({
      memexId: s.memexId,
      userId: s.ownerId,
      clientId: "sec199-test-client",
      channel: "rest_ui",
      entity: "document",
      action: "updated",
      narrative: "spec-199 security redaction test",
      payload: { internal: "data" },
    });
    expect(row, "seeded activity row should persist").not.toBeNull();

    // dev@memex.ai is NOT a member → currentAccessLevel !== "write" → columns stripped.
    const res = await app.request(
      tenantPath(s.namespaceSlug, s.memexSlug, `/activity?limit=200`),
      { headers: { Host: "memex.ai" } },
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;

    const seededRow = rows.find((r) => r.id === row!.id);
    expect(seededRow, "seeded activity row must appear in response").toBeDefined();

    for (const r of rows) {
      expect(r).not.toHaveProperty("actorUserId");
      expect(r).not.toHaveProperty("clientId");
      expect(r).not.toHaveProperty("payload");
    }
  });
});
