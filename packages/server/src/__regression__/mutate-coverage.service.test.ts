// Service coverage regression test (doc-16 t-12).
//
// For every service function in the Wave 1 doc-tree scope whose signature
// returns Promise<Mutated<T>>, this test:
//   1. Subscribes to the unified bus.
//   2. Invokes the function with valid args against a real test database.
//   3. Asserts ≥1 event was emitted on the bus during the call.
//   4. Asserts the event's (entity, action) matches the function's declared
//      mutation kind.
//
// The check is a backstop to the type brand: TypeScript forces every function
// returning Promise<Mutated<T>> to either go through `mutate()` or do an
// `as Mutated<T>` cast (forbidden by the Standard). This test catches the
// remaining failure mode — a future author who writes a mutating service
// without declaring the Mutated brand and so escapes the type check.
//
// Registry maintenance: when you add a new service function whose return
// signature is Promise<Mutated<T>>, add an entry below. The endpoint coverage
// test (mutate-coverage.endpoint.test.ts) imports the same registry to assert
// every named tool has a registered handler.

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, decisions, tasks, namespaces, orgs } from "../db/schema.js";
import { bus, type ChangeEntity, type ChangeAction } from "../services/bus.js";
import { makeTestMemex } from "../services/test-helpers.js";

import * as documentsSvc from "../services/documents.js";
import * as sectionsSvc from "../services/sections.js";
import * as decisionsSvc from "../services/decisions.js";
import * as tasksSvc from "../services/tasks.js";
import * as commentsSvc from "../services/comments.js";
import * as depsSvc from "../services/dependencies.js";
import * as docMoveSvc from "../services/doc-move.js";
import * as execPlansSvc from "../services/execution_plans.js";
import * as narrativeSvc from "../services/narrative.js";
import * as standardsSvc from "../services/standards.js";

interface Fixtures {
  memexId: string;
  otherMemexId: string;
  docId: string;
  sectionId: string;
  decisionId: string;
  taskId: string;
  taskWithBlockersId: string;
  blockerDecisionId: string;
  blockerTaskId: string;
}

async function makeFixtures(): Promise<Fixtures> {
  const memexId = await makeTestMemex("cov");
  const otherMemexId = await makeTestMemex("ocov");

  const doc = await documentsSvc.createDocDraft(memexId, "Coverage Spec", "Cover everything", "spec");
  const section = await sectionsSvc.addSection(memexId, doc.id, "context", "Initial body");
  const decision = await decisionsSvc.createDecision(memexId, doc.id, "Pick a thing");
  const task = await tasksSvc.createTask(memexId, doc.id, "Do work", "Work hard");

  const blockerDec = await decisionsSvc.createDecision(memexId, doc.id, "Blocker decision");
  const blockerTask = await tasksSvc.createTask(memexId, doc.id, "Blocker task", "First");
  const taskWithBlockers = await tasksSvc.createTask(memexId, doc.id, "Blocked task", "Needs both above");

  return {
    memexId,
    otherMemexId,
    docId: doc.id,
    sectionId: section.id,
    decisionId: decision.id,
    taskId: task.id,
    taskWithBlockersId: taskWithBlockers.id,
    blockerDecisionId: blockerDec.id,
    blockerTaskId: blockerTask.id,
  };
}

interface RegistryEntry {
  name: string;
  expected: { entity: ChangeEntity; action: ChangeAction };
  invoke: (f: Fixtures) => Promise<unknown>;
  /** Skip emission check (e.g. an idempotent path covered by a sibling test). */
  silent?: boolean;
}

// Hand-curated registry. Order is mostly arbitrary; tests within `describe.each`
// run sequentially so write dependencies (e.g. decision must exist before resolve)
// just need to be ordered correctly.
const SERVICE_REGISTRY: RegistryEntry[] = [
  // documents.ts — createDocDraft is covered by the fixture setup; assert the rest.
  {
    name: "documents.updateDocTitle",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => documentsSvc.updateDocTitle(f.memexId, f.docId, "Renamed"),
  },
  {
    name: "documents.updateDocStatus",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => documentsSvc.updateDocStatus(f.memexId, f.docId, "plan"),
  },
  {
    name: "documents.pauseDoc",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => documentsSvc.pauseDoc(f.memexId, f.docId),
  },
  {
    name: "documents.unpauseDoc",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => documentsSvc.unpauseDoc(f.memexId, f.docId),
  },
  {
    name: "documents.archiveDoc",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => documentsSvc.archiveDoc(f.memexId, f.docId),
  },
  // sections.ts
  {
    name: "sections.addSection",
    expected: { entity: "section", action: "created" },
    invoke: (f) => sectionsSvc.addSection(f.memexId, f.docId, `extra-${Date.now()}`, "More body"),
  },
  {
    name: "sections.updateSection",
    expected: { entity: "section", action: "updated" },
    invoke: (f) => sectionsSvc.updateSection(f.memexId, f.sectionId, "Updated body"),
  },
  // decisions.ts — most action: updated paths covered by approve/reject/setOptions/resolve/reopen sequence.
  {
    name: "decisions.proposeDecision",
    expected: { entity: "decision", action: "created" },
    invoke: (f) => decisionsSvc.proposeDecision(f.memexId, f.docId, { title: "Propose me" }),
  },
  // tasks.ts
  {
    name: "tasks.updateTaskStatus",
    expected: { entity: "task", action: "updated" },
    invoke: (f) => tasksSvc.updateTaskStatus(f.memexId, f.taskId, "in_progress"),
  },
  {
    name: "tasks.updateAcceptanceCriteria",
    expected: { entity: "task", action: "updated" },
    invoke: (f) => tasksSvc.updateAcceptanceCriteria(f.memexId, f.taskId, [{ description: "Done", done: true }]),
  },
  {
    name: "tasks.updateTask",
    expected: { entity: "task", action: "updated" },
    invoke: (f) => tasksSvc.updateTask(f.memexId, f.taskId, { title: "Renamed task" }),
  },
  // comments.ts
  {
    name: "comments.addComment",
    expected: { entity: "comment", action: "created" },
    invoke: (f) => commentsSvc.addComment(f.memexId, f.sectionId, "Tester", "A comment"),
  },
  {
    name: "comments.addDecisionComment",
    expected: { entity: "comment", action: "created" },
    invoke: (f) => commentsSvc.addDecisionComment(f.memexId, f.decisionId, "Tester", "A comment"),
  },
  {
    name: "comments.addTaskComment",
    expected: { entity: "comment", action: "created" },
    invoke: (f) => commentsSvc.addTaskComment(f.memexId, f.taskId, "Tester", "A comment"),
  },
  // dependencies.ts — composite path: add then remove a decision blocker.
  {
    name: "dependencies.addDecisionDep",
    expected: { entity: "dependency", action: "created" },
    invoke: (f) => depsSvc.addDecisionDep(f.memexId, f.taskWithBlockersId, f.blockerDecisionId),
  },
  {
    name: "dependencies.addTaskDep",
    expected: { entity: "dependency", action: "created" },
    invoke: (f) => depsSvc.addTaskDep(f.memexId, f.taskWithBlockersId, f.blockerTaskId),
  },
  {
    name: "dependencies.removeDecisionDep",
    expected: { entity: "dependency", action: "deleted" },
    invoke: (f) => depsSvc.removeDecisionDep(f.memexId, f.taskWithBlockersId, f.blockerDecisionId),
  },
  {
    name: "dependencies.removeTaskDep",
    expected: { entity: "dependency", action: "deleted" },
    invoke: (f) => depsSvc.removeTaskDep(f.memexId, f.taskWithBlockersId, f.blockerTaskId),
  },
  // narrative.ts
  {
    name: "narrative.markNarrativeConsolidated",
    expected: { entity: "document", action: "updated" },
    invoke: (f) => narrativeSvc.markNarrativeConsolidated(f.memexId, f.docId),
  },
  // standards.ts — standalone create (no fixture dependency)
  {
    name: "standards.createStandard",
    expected: { entity: "document", action: "created" },
    invoke: (f) =>
      standardsSvc.createStandard(f.memexId, {
        title: "Coverage Standard",
        description: "Test",
        sections: [{ sectionType: "rule", content: "Be excellent." }],
      }),
  },
  // tasks.ts deleteTask (do last — destroys f.taskId).
  {
    name: "tasks.deleteTask",
    expected: { entity: "task", action: "deleted" },
    invoke: (f) => tasksSvc.deleteTask(f.memexId, f.taskId),
  },
];

describe("doc-16 t-12: service coverage — every Mutated<T> service emits on the bus", () => {
  let fixtures: Fixtures;

  beforeAll(async () => {
    fixtures = await makeFixtures();
  });

  for (const entry of SERVICE_REGISTRY) {
    it(`${entry.name} emits ${entry.expected.entity}.${entry.expected.action}`, async () => {
      const seen: { entity: ChangeEntity; action: ChangeAction; memexId: string }[] = [];
      const unsubscribe = bus.subscribe(
        { memexId: fixtures.memexId },
        (event) => seen.push({ entity: event.entity, action: event.action, memexId: event.memexId }),
      );
      try {
        await entry.invoke(fixtures);
      } finally {
        unsubscribe();
      }
      const matched = seen.find(
        (e) => e.entity === entry.expected.entity && e.action === entry.expected.action,
      );
      expect(
        matched,
        `Expected ${entry.name} to emit ${entry.expected.entity}.${entry.expected.action}, ` +
          `but observed events: ${JSON.stringify(seen)}`,
      ).toBeDefined();
      expect(matched!.memexId).toBe(fixtures.memexId);
    });
  }

  // Cross-tenant emit: moveDoc fires on BOTH source and target memexes.
  it("doc-move.moveDoc emits document.updated on source AND target memexes", async () => {
    // Make a fresh doc + memex pair so the test is independent of prior state.
    const fromMemex = await makeTestMemex("mvfrom");
    const toMemex = await makeTestMemex("mvto");
    const doc = await documentsSvc.createDocDraft(fromMemex, "To move", "Move me", "spec");

    // Enrol the dev user as administrator on the target org so the permission check passes.
    const { upsertUserByEmail } = await import("../services/users.js");
    const { orgMemberships, memexes, namespaces } = await import("../db/schema.js");
    const targetMemexRow = await db.query.memexes.findFirst({ where: eq(memexes.id, toMemex) });
    const targetNs = await db.query.namespaces.findFirst({
      where: eq(namespaces.id, targetMemexRow!.namespaceId),
    });
    const dev = await upsertUserByEmail("dev@memex.ai");
    await db
      .insert(orgMemberships)
      .values({ userId: dev.id, orgId: targetNs!.ownerOrgId!, role: "administrator" })
      .onConflictDoNothing();

    const seen: { memexId: string; entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsubscribe = bus.subscribe({}, (event) => {
      if (event.memexId === fromMemex || event.memexId === toMemex) {
        seen.push({ memexId: event.memexId, entity: event.entity, action: event.action });
      }
    });
    try {
      await docMoveSvc.moveDoc(fromMemex, doc.id, toMemex, dev.id, {
        includeDecisions: false,
        includeTasks: false,
        includeSectionComments: false,
      });
    } finally {
      unsubscribe();
    }
    const onSource = seen.find((e) => e.memexId === fromMemex && e.entity === "document");
    const onTarget = seen.find((e) => e.memexId === toMemex && e.entity === "document");
    expect(onSource, `expected source emit; saw ${JSON.stringify(seen)}`).toBeDefined();
    expect(onTarget, `expected target emit; saw ${JSON.stringify(seen)}`).toBeDefined();
  });

  // Execution plan: createExecutionPlan emits TWO events (document.created + task.updated).
  it("execution_plans.createExecutionPlan emits document.created AND task.updated", async () => {
    const m = await makeTestMemex("execplan");
    const doc = await documentsSvc.createDocDraft(m, "Has tasks", "P", "spec");
    const task = await tasksSvc.createTask(m, doc.id, "Plan-bearing task", "D");

    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsub = bus.subscribe({ memexId: m }, (e) => seen.push({ entity: e.entity, action: e.action }));
    try {
      await execPlansSvc.createExecutionPlan(m, task.id, {
        title: "EP",
        sections: { files_modified: "x.ts" },
      });
    } finally {
      unsub();
    }
    expect(seen.some((e) => e.entity === "document" && e.action === "created")).toBe(true);
    expect(seen.some((e) => e.entity === "task" && e.action === "updated")).toBe(true);
  });

  // decisions.resolveDecision — cascade: emits one decision.updated event even though
  // it also writes to docComments (the cascade is part of one logical action per
  // the Standard's table-by-table classification, not an independent invariant).
  it("decisions.resolveDecision emits decision.updated (cascading comment-resolve is internal)", async () => {
    const dec = await decisionsSvc.createDecision(fixtures.memexId, fixtures.docId, "Resolve me");
    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsub = bus.subscribe({ memexId: fixtures.memexId }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await decisionsSvc.resolveDecision(fixtures.memexId, dec.id, "Resolved");
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "decision" && e.action === "updated")).toBeDefined();
  });
});

// Wave 3 architectural-completion: orgs, org-discovery, org-consent,
// user-namespaces. Per std-8's table-by-table classification these are all
// requires-emit (orgs / namespaces / memexes / org_memberships /
// org_consent_responses). Their writes flow through mutate() and the unified
// bus so the type-brand contract holds across the non-doc tenancy surfaces.
describe("doc-16 Wave 3: org / namespace / consent / user-namespace coverage", () => {
  it("orgs.createOrgWithOwner emits org + user_namespace + org_membership", async () => {
    // Per dec-1 of doc-19, Org creation no longer inserts a default Memex —
    // the composite emit drops the memex.created event. Events emit on the
    // owner's userId channel (memexId="") so /api/me/events delivers them.
    const { upsertUserByEmail } = await import("../services/users.js");
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const owner = await upsertUserByEmail(`cov-owner-${Date.now()}@example.com`);

    const slug = `cov-w3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const seen: { entity: ChangeEntity; action: ChangeAction; userId?: string }[] = [];
    const unsub = bus.subscribe({ userId: owner.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action, userId: e.userId }),
    );
    try {
      await createOrgWithOwner({ slug, ownerUserId: owner.id });
    } finally {
      unsub();
    }
    expect(seen.some((e) => e.entity === "org" && e.action === "created")).toBe(true);
    expect(seen.some((e) => e.entity === "user_namespace" && e.action === "created")).toBe(true);
    expect(seen.some((e) => e.entity === "org_membership" && e.action === "created")).toBe(true);
    // No memex.created — Orgs start with zero Memexes (dec-1 of doc-19).
    expect(seen.some((e) => e.entity === "memex" && e.action === "created")).toBe(false);
  });

  it("orgs.updateOrgSettings emits org.updated", async () => {
    const { createOrgWithOwner, updateOrgSettings } = await import("../services/orgs.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { memexes: memexesTbl } = await import("../db/schema.js");
    const owner = await upsertUserByEmail(`cov-upd-${Date.now()}@example.com`);
    const slug = `cov-w3u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    // Insert a Memex so updateOrgSettings' primaryMemexIdForOrg() resolves
    // and the bus event's memexId-scoped subscription matches.
    const [memex] = await db
      .insert(memexesTbl)
      .values({ namespaceId: bundle.namespace.id, slug: "main", name: "Main" })
      .returning();

    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsub = bus.subscribe({ memexId: memex.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await updateOrgSettings(bundle.org.id, { name: "Renamed Org" });
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "org" && e.action === "updated")).toBeDefined();
  });

  it("orgs.refreshOrgDomainVerifiedFlag emits org.updated", async () => {
    const { createOrgWithOwner, refreshOrgDomainVerifiedFlag } = await import("../services/orgs.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { memexes: memexesTbl } = await import("../db/schema.js");
    const owner = await upsertUserByEmail(`cov-rdv-${Date.now()}@example.com`);
    const slug = `cov-w3r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const [memex] = await db
      .insert(memexesTbl)
      .values({ namespaceId: bundle.namespace.id, slug: "main", name: "Main" })
      .returning();

    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsub = bus.subscribe({ memexId: memex.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await refreshOrgDomainVerifiedFlag(bundle.org.id);
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "org" && e.action === "updated")).toBeDefined();
  });

  it("namespaces.renameNamespaceSlug emits user_namespace.updated", async () => {
    // renameNamespaceSlug moved from services/orgs.ts to services/namespaces.ts
    // per doc-19 t-1.
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const { renameNamespaceSlug } = await import("../services/namespaces.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { memexes: memexesTbl } = await import("../db/schema.js");
    const owner = await upsertUserByEmail(`cov-rn-${Date.now()}@example.com`);
    const slug = `cov-w3rn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const [memex] = await db
      .insert(memexesTbl)
      .values({ namespaceId: bundle.namespace.id, slug: "main", name: "Main" })
      .returning();
    const newSlug = `cov-w3rnz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();

    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    const unsub = bus.subscribe({ memexId: memex.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await renameNamespaceSlug({
        namespaceId: bundle.namespace.id,
        newSlug,
        userId: owner.id,
      });
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "user_namespace" && e.action === "updated")).toBeDefined();
  });

  it("org-discovery.joinOrgByDomain emits org_membership.created on first join", async () => {
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const { joinOrgByDomain } = await import("../services/org-discovery.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { verifiedDomains, orgs: orgsTbl } = await import("../db/schema.js");

    const owner = await upsertUserByEmail(`cov-jod-owner-${Date.now()}@example.com`);
    const slug = `cov-w3jod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const domain = `cov-jod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.test`;
    // Enable auto-grouping + verify the domain on the new org.
    await db.update(orgsTbl).set({ autoGroupingEnabled: true }).where(eq(orgsTbl.id, bundle.org.id));
    await db
      .insert(verifiedDomains)
      .values({ domain, orgId: bundle.org.id, verificationMethod: "sso" });

    const joiner = await upsertUserByEmail(`joiner@${domain}`);
    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    // Subscribe by the joining user — org_membership.created is user-scoped
    // (per doc-19 / dec-1 the new org has no memex to scope on).
    const unsub = bus.subscribe({ userId: joiner.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await joinOrgByDomain(joiner.id, `joiner@${domain}`, bundle.org.id);
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "org_membership" && e.action === "created")).toBeDefined();
  });

  it("org-discovery.joinByDomain emits org_membership.created on first match", async () => {
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const { joinByDomain } = await import("../services/org-discovery.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { verifiedDomains, orgs: orgsTbl } = await import("../db/schema.js");

    const owner = await upsertUserByEmail(`cov-jbd-owner-${Date.now()}@example.com`);
    const slug = `cov-w3jbd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const domain = `cov-jbd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.test`;
    await db.update(orgsTbl).set({ autoGroupingEnabled: true }).where(eq(orgsTbl.id, bundle.org.id));
    await db
      .insert(verifiedDomains)
      .values({ domain, orgId: bundle.org.id, verificationMethod: "sso" });

    const joiner = await upsertUserByEmail(`joiner2@${domain}`);
    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    // Subscribe by the joining user (see joinOrgByDomain comment above).
    const unsub = bus.subscribe({ userId: joiner.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await joinByDomain(joiner.id, `joiner2@${domain}`);
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "org_membership" && e.action === "created")).toBeDefined();
  });

  it("org-consent.acceptConsent emits org_membership.created AND org_consent.created", async () => {
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const { acceptConsent } = await import("../services/org-consent.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const { verifiedDomains, orgs: orgsTbl } = await import("../db/schema.js");

    const owner = await upsertUserByEmail(`cov-ac-owner-${Date.now()}@example.com`);
    const slug = `cov-w3ac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const domain = `cov-ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.test`;
    await db.update(orgsTbl).set({ autoGroupingEnabled: true }).where(eq(orgsTbl.id, bundle.org.id));
    await db
      .insert(verifiedDomains)
      .values({ domain, orgId: bundle.org.id, verificationMethod: "sso" });

    const acceptor = await upsertUserByEmail(`acceptor@${domain}`);
    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    // Subscribe by the consenting user (events are user-scoped).
    const unsub = bus.subscribe({ userId: acceptor.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await acceptConsent(acceptor.id, bundle.org.id);
    } finally {
      unsub();
    }
    expect(seen.some((e) => e.entity === "org_membership" && e.action === "created")).toBe(true);
    expect(seen.some((e) => e.entity === "org_consent" && e.action === "created")).toBe(true);
  });

  it("org-consent.recordConsentDismissal emits org_consent.created", async () => {
    const { createOrgWithOwner } = await import("../services/orgs.js");
    const { recordConsentDismissal } = await import("../services/org-consent.js");
    const { upsertUserByEmail } = await import("../services/users.js");

    const owner = await upsertUserByEmail(`cov-rcd-owner-${Date.now()}@example.com`);
    const slug = `cov-w3rcd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
    const bundle = await createOrgWithOwner({ slug, ownerUserId: owner.id });
    const dismisser = await upsertUserByEmail(`dismisser-${Date.now()}@example.com`);

    const seen: { entity: ChangeEntity; action: ChangeAction }[] = [];
    // Subscribe by the dismissing user (events are user-scoped).
    const unsub = bus.subscribe({ userId: dismisser.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await recordConsentDismissal(dismisser.id, bundle.org.id, "declined");
    } finally {
      unsub();
    }
    expect(seen.find((e) => e.entity === "org_consent" && e.action === "created")).toBeDefined();
  });

  it("mcp-tokens.mintMcpToken emits mcp_token.created with userId", async () => {
    const { mintMcpToken } = await import("../services/mcp-tokens.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const u = await upsertUserByEmail(`cov-mint-${Date.now()}@example.com`);

    const seen: { entity: ChangeEntity; action: ChangeAction; userId?: string }[] = [];
    const unsub = bus.subscribe({ userId: u.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action, userId: e.userId }),
    );
    try {
      await mintMcpToken(u.id, "Cov device");
    } finally {
      unsub();
    }
    const match = seen.find((e) => e.entity === "mcp_token" && e.action === "created");
    expect(match).toBeDefined();
    expect(match!.userId).toBe(u.id);
  });

  it("mcp-tokens.revokeMcpToken emits mcp_token.deleted with userId", async () => {
    const { mintMcpToken, revokeMcpToken } = await import("../services/mcp-tokens.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const u = await upsertUserByEmail(`cov-revoke-${Date.now()}@example.com`);
    const { row } = await mintMcpToken(u.id, "Cov revokable");

    const seen: { entity: ChangeEntity; action: ChangeAction; userId?: string }[] = [];
    const unsub = bus.subscribe({ userId: u.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action, userId: e.userId }),
    );
    try {
      await revokeMcpToken(row.id, u.id);
    } finally {
      unsub();
    }
    const match = seen.find((e) => e.entity === "mcp_token" && e.action === "deleted");
    expect(match).toBeDefined();
    expect(match!.userId).toBe(u.id);
  });

  it("slack-oauth.storeUserSlackToken emits user_slack_token.created with userId", async () => {
    const { storeUserSlackToken } = await import("../services/.ee/slack/oauth.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const u = await upsertUserByEmail(`cov-slack-store-${Date.now()}@example.com`);
    const tag = Date.now().toString(36);
    const [ns] = await db.insert(namespaces).values({ slug: `cov-sl-st-${tag}`, kind: "org" }).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Cov Test Org" }).returning();
    // b-70 t-3 / dec-6: point the org namespace at its owning org so it honours
    // the owner-XOR invariant (migration-smoke asserts this on every row). An
    // ownerless org namespace is exactly the cruft the strict check catches.
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));

    const seen: { entity: ChangeEntity; action: ChangeAction; userId?: string }[] = [];
    const unsub = bus.subscribe({ userId: u.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action, userId: e.userId }),
    );
    try {
      await storeUserSlackToken({
        userId: u.id,
        orgId: org.id,
        slackUserId: "U_COV_STORE",
        slackWorkspaceId: "T_COV",
        accessToken: "xoxp-cov-store-token",
        scope: "chat:write",
      });
    } finally {
      unsub();
      await db.delete(namespaces).where(eq(namespaces.id, ns.id)).catch(() => {});
    }
    const match = seen.find((e) => e.entity === "user_slack_token" && e.action === "created");
    expect(match).toBeDefined();
    expect(match!.userId).toBe(u.id);
  });

  it("slack-oauth.markUserSlackTokenRevoked emits user_slack_token.deleted with userId", async () => {
    const { storeUserSlackToken, markUserSlackTokenRevoked } = await import("../services/.ee/slack/oauth.js");
    const { upsertUserByEmail } = await import("../services/users.js");
    const u = await upsertUserByEmail(`cov-slack-revoke-${Date.now()}@example.com`);
    const tag = Date.now().toString(36);
    const [ns] = await db.insert(namespaces).values({ slug: `cov-sl-rv-${tag}`, kind: "org" }).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Cov Test Org" }).returning();
    // b-70 t-3 / dec-6: point the org namespace at its owning org so it honours
    // the owner-XOR invariant (migration-smoke asserts this on every row). An
    // ownerless org namespace is exactly the cruft the strict check catches.
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    await storeUserSlackToken({
      userId: u.id,
      orgId: org.id,
      slackUserId: "U_COV_REVOKE",
      slackWorkspaceId: "T_COV",
      accessToken: "xoxp-cov-revoke-token",
      scope: "chat:write",
    });

    const seen: { entity: ChangeEntity; action: ChangeAction; userId?: string }[] = [];
    const unsub = bus.subscribe({ userId: u.id }, (e) =>
      seen.push({ entity: e.entity, action: e.action, userId: e.userId }),
    );
    try {
      await markUserSlackTokenRevoked(u.id, org.id);
    } finally {
      unsub();
      await db.delete(namespaces).where(eq(namespaces.id, ns.id)).catch(() => {});
    }
    const match = seen.find((e) => e.entity === "user_slack_token" && e.action === "deleted");
    expect(match).toBeDefined();
    expect(match!.userId).toBe(u.id);
  });

  it("user-namespaces.ensureUserNamespace emits user_namespace.created AND memex.created on first call", async () => {
    const { upsertUserByEmail } = await import("../services/users.js");
    const { ensureUserNamespace } = await import("../services/user-namespaces.js");
    const fresh = await upsertUserByEmail(`cov-ens-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);

    const seen: { entity: ChangeEntity; action: ChangeAction; memexId: string }[] = [];
    const unsub = bus.subscribe({}, (e) =>
      seen.push({ entity: e.entity, action: e.action, memexId: e.memexId }),
    );
    let memexId = "";
    try {
      const result = await ensureUserNamespace(fresh.id);
      memexId = result.memex.id;
    } finally {
      unsub();
    }
    const here = seen.filter((e) => e.memexId === memexId);
    expect(here.some((e) => e.entity === "user_namespace" && e.action === "created")).toBe(true);
    expect(here.some((e) => e.entity === "memex" && e.action === "created")).toBe(true);
  });
});

// Suppress linter complaints about unused imports — Drizzle schema is imported
// for type completeness even though no top-level query needs it here.
void documents;
void docSections;
void decisions;
void tasks;
