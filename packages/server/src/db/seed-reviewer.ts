// b-31 W5 t-10 — provision the Anthropic Connectors Directory reviewer account.
//
// Usage:
//   DATABASE_URL=... tsx src/db/seed-reviewer.ts
//
// Idempotent: re-running is safe. The script ensures:
//   1. User `mcp-review@memex.ai` exists, with a personal namespace + Memex.
//   2. Org `Memex Reviewer Sandbox` exists with `memex-reviewer` namespace,
//      `main` Memex, and the reviewer enrolled as administrator.
//   3. The org Memex carries a Spec with 3 sections, 2 resolved + 1 open
//      decision, tasks in each status (not_started/in_progress/complete), one
//      comment of every commentType, a Standard, and an execution plan.
//   4. A fresh mxt_ PAT is minted for the reviewer (printed to stdout) — the
//      reviewer can paste it into the manual MCP config OR run the connector
//      OAuth flow against this account.
//
// Run BEFORE the directory submission; keep the printed mxt_ token + Slack it
// to the reviewer (or paste into the submission form's "test credentials"
// field). The Spec / Standard / tasks here are what the reviewer will see
// when they exercise each tool.

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema.js";
import {
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  users,
  documents,
  docSections,
  decisions,
  tasks,
} from "./schema.js";
import { mintMcpToken } from "../services/mcp-tokens.js";
import { addTaskComment } from "../services/comments.js";
import { COMMENT_TYPES } from "../types/roles.js";

const REVIEWER_EMAIL = "mcp-review@memex.ai";
const ORG_NAMESPACE_SLUG = "memex-reviewer";
const ORG_MEMEX_SLUG = "main";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  console.log("Seeding reviewer account…");

  // ── 1. User ─────────────────────────────────────────────────────────
  let user = await db.query.users.findFirst({ where: eq(users.email, REVIEWER_EMAIL) });
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: REVIEWER_EMAIL,
        emailVerifiedAt: new Date(),
      } as typeof users.$inferInsert)
      .returning();
    console.log(`  Created user ${user.id} <${REVIEWER_EMAIL}>`);
  } else {
    console.log(`  User exists: ${user.id} <${REVIEWER_EMAIL}>`);
  }

  // ── 1a. Personal namespace + Memex ───────────────────────────────────
  const personalSlug = "mcp-review";
  let personalNs = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, personalSlug),
  });
  if (!personalNs) {
    [personalNs] = await db
      .insert(namespaces)
      .values({ slug: personalSlug, kind: "user", ownerUserId: user.id })
      .returning();
    await db
      .insert(memexes)
      .values({ namespaceId: personalNs.id, slug: "main", name: "Personal" });
    console.log(`  Created personal namespace ${personalSlug}`);
  }

  // ── 2. Org + org Memex ──────────────────────────────────────────────
  let orgNs = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, ORG_NAMESPACE_SLUG),
  });
  let orgRow: typeof orgs.$inferSelect | undefined;
  if (!orgNs) {
    [orgNs] = await db
      .insert(namespaces)
      .values({ slug: ORG_NAMESPACE_SLUG, kind: "org" })
      .returning();
    [orgRow] = await db
      .insert(orgs)
      .values({ namespaceId: orgNs.id, name: "Memex Reviewer Sandbox" })
      .returning();
    await db
      .update(namespaces)
      .set({ ownerOrgId: orgRow.id })
      .where(eq(namespaces.id, orgNs.id));
    console.log(`  Created org namespace ${ORG_NAMESPACE_SLUG}`);
  } else {
    orgRow = await db.query.orgs.findFirst({ where: eq(orgs.namespaceId, orgNs.id) });
    if (!orgRow) throw new Error("org namespace without org row — manual cleanup needed");
  }

  let orgMemex = await db.query.memexes.findFirst({
    where: and(eq(memexes.namespaceId, orgNs.id), eq(memexes.slug, ORG_MEMEX_SLUG)),
  });
  if (!orgMemex) {
    [orgMemex] = await db
      .insert(memexes)
      .values({ namespaceId: orgNs.id, slug: ORG_MEMEX_SLUG, name: "Main" })
      .returning();
  }

  // Enrol reviewer as administrator (idempotent).
  const existingMembership = await db.query.orgMemberships.findFirst({
    where: and(
      eq(orgMemberships.userId, user.id),
      eq(orgMemberships.orgId, orgRow.id),
    ),
  });
  if (!existingMembership) {
    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: orgRow.id,
      role: "administrator",
      status: "active",
    } as typeof orgMemberships.$inferInsert);
    console.log(`  Enrolled reviewer as administrator of ${ORG_NAMESPACE_SLUG}`);
  }

  // ── 3. Spec + sections + decisions + tasks + comments ──────────────
  // Pin a stable handle so re-runs find the same Spec.
  let spec = await db.query.documents.findFirst({
    where: and(eq(documents.memexId, orgMemex.id), eq(documents.handle, "spec-1")),
  });
  if (!spec) {
    [spec] = await db
      .insert(documents)
      .values({
        memexId: orgMemex.id,
        handle: "spec-1",
        title: "Anthropic Connectors Directory — sample Spec for reviewers",
        docType: "spec",
        status: "build",
        createdByUserId: user.id,
      })
      .returning();
    console.log(`  Created sample Spec ${spec.handle}`);

    // 3 sections — Overview, Approach, Acceptance Criteria.
    await db.insert(docSections).values([
      {
        docId: spec.id,
        sectionType: "overview",
        title: "Overview",
        content:
          "This Spec exists so directory reviewers can see how Memex models a body of work. " +
          "It is intentionally minimal — three sections, three decisions, three tasks, and " +
          "comments of every type. Tools can be called against this Spec without affecting " +
          "real data.",
        seq: 1,
        position: 1,
      },
      {
        docId: spec.id,
        sectionType: "approach",
        title: "Approach",
        content:
          "The reviewer can call list_docs, get_doc, list_tasks, update_task (any status), " +
          "add_comment with each commentType, create_decision, and resolve_decision against " +
          "this Spec. Nothing destructive happens to other users.",
        seq: 2,
        position: 2,
      },
      {
        docId: spec.id,
        sectionType: "acceptance",
        title: "Acceptance Criteria",
        content:
          "- Every tool in the MCP catalogue executes without error.\n" +
          "- Destructive operations (delete_task) prompt the user for confirmation.\n" +
          "- Tool responses are bounded (no full doc dumps by default).",
        seq: 3,
        position: 3,
      },
    ]);

    // 3 decisions: 2 resolved, 1 open. `handle` is derived from `seq` (dec-N)
    // by the formatters, so we only set seq here.
    await db.insert(decisions).values([
      {
        docId: spec.id,
        memexId: orgMemex.id,
        seq: 1,
        title: "How will reviewers exercise destructive tools?",
        context: "delete_task is the only destructiveHint:true tool in v1.",
        status: "resolved",
        resolution:
          "Reviewers should call delete_task with a task UUID they created via " +
          "create_task — never against a pre-seeded task. The Claude client prompts " +
          "before calling because of the destructive annotation.",
        resolvedAt: new Date(),
      },
      {
        docId: spec.id,
        memexId: orgMemex.id,
        seq: 2,
        title: "Scope of the reviewer Memex",
        context: "Whether to seed a personal Memex, an org Memex, or both.",
        status: "resolved",
        resolution:
          "Both — list_memexes shows the reviewer the namespace-vs-org distinction " +
          "and forces them to pick one before mutating.",
        resolvedAt: new Date(),
      },
      {
        docId: spec.id,
        memexId: orgMemex.id,
        seq: 3,
        title: "Should we seed additional Specs for the reviewer to exercise?",
        context:
          "One Spec covers the entire surface, but multiple Specs would let " +
          "list_docs return a more interesting result.",
        status: "open",
      },
    ]);

    // 3 tasks: not_started, in_progress, complete. handles derived from seq
    // by the formatter (t-N).
    const insertedTasks = await db
      .insert(tasks)
      .values([
        {
          docId: spec.id,
          memexId: orgMemex.id,
          sectionRef: "overview",
          seq: 1,
          title: "Exercise list_memexes",
          description: "Confirm the reviewer sees both personal + org Memexes.",
          status: "complete",
        },
        {
          docId: spec.id,
          memexId: orgMemex.id,
          sectionRef: "overview",
          seq: 2,
          title: "Exercise update_task with each status",
          description: "Walk a task through not_started → in_progress → complete.",
          status: "in_progress",
        },
        {
          docId: spec.id,
          memexId: orgMemex.id,
          sectionRef: "overview",
          seq: 3,
          title: "Try delete_task on a freshly-created task",
          description: "Confirms the destructiveHint annotation triggers confirmation in Claude.",
          status: "not_started",
        },
      ])
      .returning();

    // One comment of every commentType on the in_progress task. Exactly one of
    // (sectionId, decisionId, taskId) MUST be set per the check constraint;
    // we attach all comments to the task. addTaskComment handles docId backfill
    // and per-doc seq allocation (introduced by b-36).
    const sampleTask = insertedTasks[1];
    for (const type of COMMENT_TYPES) {
      await addTaskComment(
        orgMemex!.id,
        sampleTask.id,
        "Reviewer seed",
        `Sample ${type} comment — exercises list_comments + update_comment.`,
        { type, source: "human" },
      );
    }
    console.log(`  Seeded ${COMMENT_TYPES.length} comments (one per type)`);
  } else {
    console.log(`  Sample Spec already exists (${spec.handle})`);
  }

  // ── 4. One Standard ─────────────────────────────────────────────────
  let std = await db.query.documents.findFirst({
    where: and(eq(documents.memexId, orgMemex.id), eq(documents.handle, "std-1")),
  });
  if (!std) {
    [std] = await db
      .insert(documents)
      .values({
        memexId: orgMemex.id,
        handle: "std-1",
        title: "Reviewer-exercise Standard — readonly tools are safe to call",
        docType: "standard",
        status: "approved",
        createdByUserId: user.id,
      })
      .returning();
    await db.insert(docSections).values({
      docId: std.id,
      sectionType: "rule",
      title: "Rule",
      content:
        "All `readOnlyHint: true` tools can be called without side effects. " +
        "Reviewers should exercise every one against this account.",
      seq: 1,
      position: 1,
    });
    console.log(`  Created sample Standard ${std.handle}`);
  }

  // ── 5. Execution plan (a doc whose docType='execution_plan') ─────────
  let plan = await db.query.documents.findFirst({
    where: and(eq(documents.memexId, orgMemex.id), eq(documents.handle, "doc-1")),
  });
  if (!plan) {
    [plan] = await db
      .insert(documents)
      .values({
        memexId: orgMemex.id,
        handle: "doc-1",
        title: "Sample execution plan — exercises submit_execution_plan/get_execution_plan flow",
        docType: "execution_plan",
        status: "draft",
        createdByUserId: user.id,
      })
      .returning();
    await db.insert(docSections).values({
      docId: plan.id,
      sectionType: "plan",
      title: "Plan",
      content: "Step-by-step plan body. Reviewers can fetch this via get_execution_plan(t-2).",
      seq: 1,
      position: 1,
    });
    console.log(`  Created sample execution plan ${plan.handle}`);
  }

  // ── 6. Mint a fresh mxt_ PAT ────────────────────────────────────────
  const minted = await mintMcpToken(user.id, "Anthropic reviewer (seed)");
  console.log("");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`Reviewer account:   ${REVIEWER_EMAIL}`);
  console.log(`User UUID:          ${user.id}`);
  console.log(`Personal namespace: ${personalSlug}`);
  console.log(`Org namespace:      ${ORG_NAMESPACE_SLUG}`);
  console.log(`Org Memex:          ${ORG_NAMESPACE_SLUG}/${ORG_MEMEX_SLUG}`);
  console.log("");
  console.log(`mxt_ PAT (one-shot — copy NOW):`);
  console.log(`  ${minted.raw}`);
  console.log("");
  console.log("Paste into the Anthropic submission form OR run the OAuth flow");
  console.log("against this account from claude.ai.");
  console.log("──────────────────────────────────────────────────────────");

  await client.end();
}

main().catch((err) => {
  console.error("seed-reviewer failed:", err);
  process.exit(1);
});
