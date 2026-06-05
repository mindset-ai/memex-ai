import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  users,
  documents,
  docSections,
  docComments,
  decisions,
  tasks,
  inviteTokens,
  shareTokens,
  verifiedDomains,
  domainVerificationTokens,
} from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { createInviteToken } from "../services/invite-tokens.js";
import { createShareToken } from "../services/share-tokens.js";
import { createDomainVerificationToken } from "../services/domain-verification.js";

// Regression: deleting a namespace must cascade-delete every child resource. If a
// future migration forgets ON DELETE CASCADE on a new FK, orphaned rows accumulate.
//
// Post-doc-15 cascade contract (rewritten in t-19):
//   - namespaces (ROOT) ← orgs (ns_id, CASCADE) ← org_memberships, invite_tokens,
//                                                  verified_domains, dvt (org_id, CASCADE)
//   - namespaces (ROOT) ← memexes (ns_id, CASCADE) ← documents (memex_id, CASCADE)
//                                                ← documents → sections, decisions,
//                                                  tasks, share_tokens, doc_comments
//
// One namespace delete should wipe the entire tree.

const leftoverUserIds: string[] = [];

afterAll(async () => {
  if (leftoverUserIds.length) {
    await db.delete(users).where(inArray(users.id, leftoverUserIds)).catch(() => {});
  }
});

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
}

describe("regression: cascade delete integrity (post-doc-15)", () => {
  it("deleting a namespace drops every dependent row across all tables", async () => {
    // Seed an org-kind namespace with the full tree of org-scoped + memex-scoped rows.
    const slug = uniqueSlug("cascade");
    const [namespace] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: namespace.id, name: "Cascade Org" }).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, namespace.id));
    const [memex] = await db.insert(memexes).values({ namespaceId: namespace.id, slug: "main", name: "Main" }).returning();

    // Membership on the org
    const member = await upsertUserByEmail(`cascade-${Date.now().toString(36)}@example.com`);
    leftoverUserIds.push(member.id);
    await db.insert(orgMemberships).values({
      userId: member.id,
      orgId: org.id,
      role: "member",
    });

    // Invite token (org-scoped)
    await createInviteToken(org.id);

    // Verified domain + DVT (org-scoped). createDomainVerificationToken requires
    // the domain to be present in the org's emailDomains list.
    const uniqueDomain = `cascade-${Date.now().toString(36)}.test`;
    await db.update(orgs).set({ emailDomains: [uniqueDomain] }).where(eq(orgs.id, org.id));
    await createDomainVerificationToken(org.id, uniqueDomain);
    await db.insert(verifiedDomains).values({
      domain: uniqueDomain,
      orgId: org.id,
      verificationMethod: "email",
    });

    // Doc (with auto-created section) + decision + task (memex-scoped)
    const doc = await createDocDraft(memex.id, "Cascade Doc", "purpose");
    const decision = await createDecision(memex.id, doc.id, "A decision");
    const task = await createTask(memex.id, doc.id, "A task", "x");

    // Share token on the doc (cascades via document)
    await createShareToken(memex.id, doc.id);

    // Comment on the section (cascades via section -> doc). b-36 T-2:
    // doc_comments now requires (doc_id, seq); we insert seq=1 since this
    // fixture creates exactly one comment per doc.
    await db.insert(docComments).values({
      memexId: memex.id,
      docId: doc.id,
      seq: 1,
      sectionId: doc.sections[0].id,
      authorName: "Tester",
      content: "hello",
    });

    // Sanity — the data is really there before we delete.
    const before = await rowCounts({ namespaceId: namespace.id, orgId: org.id, memexId: memex.id });
    expect(before.namespace).toBe(1);
    expect(before.org).toBe(1);
    expect(before.memex).toBe(1);
    expect(before.memberships).toBeGreaterThan(0);
    expect(before.invites).toBeGreaterThan(0);
    expect(before.docs).toBeGreaterThan(0);
    expect(before.sections).toBeGreaterThan(0);
    expect(before.decisions).toBeGreaterThan(0);
    expect(before.tasks).toBeGreaterThan(0);
    expect(before.shareTokens).toBeGreaterThan(0);
    expect(before.domainVerificationTokens).toBeGreaterThan(0);
    expect(before.verifiedDomains).toBeGreaterThan(0);
    expect(before.comments).toBeGreaterThan(0);

    // Delete the namespace — cascades through orgs (and org_memberships /
    // invite_tokens / verified_domains / dvt) AND memexes (and
    // documents / sections / decisions / tasks / share_tokens / doc_comments).
    await db.delete(namespaces).where(eq(namespaces.id, namespace.id));

    const after = await rowCounts({ namespaceId: namespace.id, orgId: org.id, memexId: memex.id });
    expect(after.namespace).toBe(0);
    expect(after.org).toBe(0);
    expect(after.memex).toBe(0);
    expect(after.memberships).toBe(0);
    expect(after.invites).toBe(0);
    expect(after.docs).toBe(0);
    expect(after.sections).toBe(0);
    expect(after.decisions).toBe(0);
    expect(after.tasks).toBe(0);
    expect(after.shareTokens).toBe(0);
    expect(after.domainVerificationTokens).toBe(0);
    expect(after.verifiedDomains).toBe(0);
    expect(after.comments).toBe(0);

    // The user itself survives — they might be a member of other orgs.
    const survivor = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(survivor?.id).toBe(member.id);

    // Suppress unused-var warnings from the declarative seeding above.
    void decision;
    void task;
  }, 30_000);
});

// Counts every resource tied to a namespace/org/memex tuple, transitively. Transitive
// counts (doc→section, doc→decision→comment, etc.) are included so a regression in
// any FK gets caught here rather than in a downstream flaky test.
async function rowCounts(ids: {
  namespaceId: string;
  orgId: string;
  memexId: string;
}) {
  const [{ c: namespaceCount }] = await db
    .select({ c: sqlCount("*") })
    .from(namespaces)
    .where(eq(namespaces.id, ids.namespaceId));

  const [{ c: orgCount }] = await db
    .select({ c: sqlCount("*") })
    .from(orgs)
    .where(eq(orgs.id, ids.orgId));

  const [{ c: memexCount }] = await db
    .select({ c: sqlCount("*") })
    .from(memexes)
    .where(eq(memexes.id, ids.memexId));

  const [{ c: membershipCount }] = await db
    .select({ c: sqlCount("*") })
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, ids.orgId));

  const [{ c: inviteCount }] = await db
    .select({ c: sqlCount("*") })
    .from(inviteTokens)
    .where(eq(inviteTokens.orgId, ids.orgId));

  const docsInMemex = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.memexId, ids.memexId));
  const docIds = docsInMemex.map((d) => d.id);

  const sections = docIds.length
    ? await db.select({ id: docSections.id }).from(docSections).where(inArray(docSections.docId, docIds))
    : [];

  const decs = docIds.length
    ? await db.select({ id: decisions.id }).from(decisions).where(inArray(decisions.docId, docIds))
    : [];

  const tks = docIds.length
    ? await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.docId, docIds))
    : [];

  const [{ c: shareCount }] = docIds.length
    ? await db
        .select({ c: sqlCount("*") })
        .from(shareTokens)
        .where(inArray(shareTokens.documentId, docIds))
    : [{ c: 0 }];

  const [{ c: dvCount }] = await db
    .select({ c: sqlCount("*") })
    .from(domainVerificationTokens)
    .where(eq(domainVerificationTokens.orgId, ids.orgId));

  const [{ c: vdCount }] = await db
    .select({ c: sqlCount("*") })
    .from(verifiedDomains)
    .where(eq(verifiedDomains.orgId, ids.orgId));

  const [{ c: commentCount }] = await db
    .select({ c: sqlCount("*") })
    .from(docComments)
    .where(eq(docComments.memexId, ids.memexId));

  return {
    namespace: Number(namespaceCount),
    org: Number(orgCount),
    memex: Number(memexCount),
    memberships: Number(membershipCount),
    invites: Number(inviteCount),
    docs: docIds.length,
    sections: sections.length,
    decisions: decs.length,
    tasks: tks.length,
    shareTokens: Number(shareCount),
    domainVerificationTokens: Number(dvCount),
    verifiedDomains: Number(vdCount),
    comments: Number(commentCount),
  };
}

function sqlCount(expr: string) {
  return sql<number>`count(${sql.raw(expr)})`.mapWith(Number);
}
