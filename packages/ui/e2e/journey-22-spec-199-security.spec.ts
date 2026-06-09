// Journey 22 — spec-199: security-hardening acceptance criteria, verified
// end-to-end against the running server.
//
// Journey 1 (ac-1): A non-member calling doc-members + doc-assignees on a public
//   Memex receives email: null on every entry — email is never leaked to an
//   unauthenticated or non-member caller.
//
// Journey 2 (ac-3): Removing a member from an org bulk-revokes all share tokens
//   they created. Replaying a revoked token returns 410.
//
// Journey 3 (ac-6): The activity endpoint on a public Memex, accessed by a
//   non-member, omits actorUserId, clientId, and payload from every row.
//
// Dev-mode auth note: GOOGLE_CLIENT_ID="" causes the server to auto-authenticate
// every token-less request as dev@memex.ai. For Journeys 1 and 3, dev is NOT a
// member of alice's org — so publicSessionMiddleware leaves currentMemexId=null
// (isMember=false) and currentAccessLevel=null (!=="write"), triggering both
// redaction paths. Journey 2 adds dev as admin to satisfy the last-admin guard
// before calling the /disable-member test endpoint directly.

import { test, expect, seedOrg, addOrgMember, ensureUser, seedSpecInMemex,
  seedAssignee, setMemexVisibility, seedActivityRow, disableMember } from "./helpers/index.js";
import { seedShareToken } from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

function api(ns: string, mx: string, path: string): string {
  return `${API_URL}/api/${ns}/${mx}${path}`;
}

// ── Journey 1: email redaction on non-member path (ac-1) ─────────────────────

test.describe("spec-199 security — email redaction (ac-1)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    await emitAcEvents(
      ["mindset-prod/memex-building-itself/specs/spec-199/acs/ac-1"],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-22-spec-199-security.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test("doc-members and doc-assignees return email:null for a non-member on a public memex", async ({
    request,
    resources,
  }) => {
    const aliceEmail = resources.email("sec199-alice-j1");
    const slug = resources.slug("sec199-j1");

    const aliceId = await ensureUser(aliceEmail);
    const { namespaceSlug, memexSlug, memexId } = await seedOrg({
      ownerEmail: aliceEmail,
      slug,
    });

    await setMemexVisibility({ memexId, visibility: "public" });

    const { docId } = await seedSpecInMemex({
      memexId,
      title: "Email redaction test spec",
      createdByUserId: aliceId,
    });
    await seedAssignee({ memexId, docId, userId: aliceId });

    // dev@memex.ai is NOT a member of alice's org → isMember=false → email stripped
    const membersRes = await request.get(api(namespaceSlug, memexSlug, `/doc-members/doc/${docId}`));
    expect(membersRes.status()).toBe(200);
    const members = await membersRes.json() as { editors: Array<{ email: string | null }> };
    expect(members.editors.length).toBeGreaterThan(0);
    for (const editor of members.editors) {
      expect(editor.email).toBeNull();
    }

    const assigneesRes = await request.get(api(namespaceSlug, memexSlug, `/doc-assignees/doc/${docId}`));
    expect(assigneesRes.status()).toBe(200);
    const assignees = await assigneesRes.json() as Array<{ email: string | null }>;
    expect(assignees.length).toBeGreaterThan(0);
    for (const assignee of assignees) {
      expect(assignee.email).toBeNull();
    }
  });
});

// ── Journey 2: revoked share token returns 410 (ac-3) ────────────────────────

test.describe("spec-199 security — share token revocation (ac-3)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    await emitAcEvents(
      ["mindset-prod/memex-building-itself/specs/spec-199/acs/ac-3"],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-22-spec-199-security.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test("removing a member bulk-revokes their share tokens — replay returns 410", async ({
    request,
    resources,
  }) => {
    const aliceEmail = resources.email("sec199-alice-j2");
    const slug = resources.slug("sec199-j2");

    const aliceId = await ensureUser(aliceEmail);
    const { orgId, memexId } = await seedOrg({
      ownerEmail: aliceEmail,
      slug,
    });

    // dev must be admin so the last-admin guard passes when alice is disabled
    await addOrgMember({ orgId, email: "dev@memex.ai", role: "administrator" });

    const { docId } = await seedSpecInMemex({
      memexId,
      title: "Share token revocation test spec",
      createdByUserId: aliceId,
    });

    // Mint a share token attributed to alice so disableMembership bulk-revokes it
    const { token: shareToken } = await seedShareToken({ memexId, docId, createdByUserId: aliceId });

    // Sanity: token is valid before revocation
    const beforeRes = await request.get(`${API_URL}/api/share/${shareToken}`);
    expect(beforeRes.status()).toBe(200);

    // Disable alice → bulk-revoke fires (org-memberships.ts disableMembership).
    // Uses the test endpoint directly so sessionMiddleware auth is bypassed;
    // dev was added as admin above so the last-admin guard passes (adminCount=2).
    await disableMember({ orgId, targetUserId: aliceId });

    // Revoked token must return 410 (share.ts: err.reason === "revoked")
    const afterRes = await request.get(`${API_URL}/api/share/${shareToken}`);
    expect(afterRes.status()).toBe(410);
  });
});

// ── Journey 3: activity column redaction on non-member path (ac-6) ───────────

test.describe("spec-199 security — activity column redaction (ac-6)", () => {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    await emitAcEvents(
      ["mindset-prod/memex-building-itself/specs/spec-199/acs/ac-6"],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-22-spec-199-security.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test("activity endpoint omits actorUserId, clientId, payload for a non-member on a public memex", async ({
    request,
    resources,
  }) => {
    const aliceEmail = resources.email("sec199-alice-j3");
    const slug = resources.slug("sec199-j3");

    const aliceId = await ensureUser(aliceEmail);
    const { namespaceSlug, memexSlug, memexId } = await seedOrg({
      ownerEmail: aliceEmail,
      slug,
    });

    await setMemexVisibility({ memexId, visibility: "public" });

    // Plant a row with all three sensitive fields set — without this the loop is
    // vacuously true on an empty activity list.
    const { activityId } = await seedActivityRow({
      memexId,
      actorUserId: aliceId,
      clientId: "sec199-test-client",
      payload: { internal: "data" },
      narrative: "spec-199 security redaction test",
    });

    // dev@memex.ai is NOT a member → currentAccessLevel=null (!=="write") → columns stripped
    const res = await request.get(api(namespaceSlug, memexSlug, `/activity?limit=200`));
    expect(res.status()).toBe(200);
    const rows = await res.json() as Array<Record<string, unknown>>;

    const seededRow = rows.find((r) => r.id === activityId);
    expect(seededRow, "seeded activity row must appear in response").toBeDefined();

    for (const row of rows) {
      expect(row).not.toHaveProperty("actorUserId");
      expect(row).not.toHaveProperty("clientId");
      expect(row).not.toHaveProperty("payload");
    }
  });
});
