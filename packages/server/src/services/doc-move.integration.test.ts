import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgMemberships,
  documents,
  docComments,
  decisions,
  tasks,
  acs,
  issues,
  docMembers,
  docAssignees,
  qaReportViews,
  shareTokens,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { createDocDraft, getDoc } from "./documents.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { addComment, addDecisionComment, addTaskComment } from "./comments.js";
import { upsertUserByEmail } from "./users.js";
import { createShareToken } from "./share-tokens.js";
import { moveDoc } from "./doc-move.js";
import { bus } from "./bus.js";
import type { RequestCtx } from "./mutate.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-293: cross-tenant Spec move. The move re-points memex_id ACROSS the RLS
// tenant wall (the prod-only 500 this Spec fixes) via the SECURITY DEFINER
// move_doc() function (migration 0094). A Spec now moves WHOLE (dec-2) and ALL
// comments travel with it (dec-3); there are no per-artifact opt-outs.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-293";
const ac = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexA: string;
let memexB: string;
let memexC: string;
let userId: string;
let outsiderUserId: string;

function ctxFor(uid: string): RequestCtx {
  return { actorUserId: uid, actorName: "Mover", channel: "rest_ui" };
}

async function orgIdForMemex(memexId: string): Promise<string> {
  const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!m) throw new Error(`Memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, m.namespaceId) });
  if (!ns?.ownerOrgId) throw new Error(`Namespace ${m.namespaceId} has no owner_org_id`);
  return ns.ownerOrgId;
}

beforeAll(async () => {
  memexA = await makeTestMemex("mva");
  memexB = await makeTestMemex("mvb");
  memexC = await makeTestMemex("mvc");

  const user = await upsertUserByEmail(`doc-move-member-${Date.now()}@memex.ai`);
  userId = user.id;
  const outsider = await upsertUserByEmail(`doc-move-outsider-${Date.now()}@memex.ai`);
  outsiderUserId = outsider.id;

  // Member of A and B, NOT C. outsider isn't a member of anything relevant.
  const orgIdA = await orgIdForMemex(memexA);
  const orgIdB = await orgIdForMemex(memexB);
  await db
    .insert(orgMemberships)
    .values([
      { userId, orgId: orgIdA, role: "administrator" },
      { userId, orgId: orgIdB, role: "member" },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(memexes)
    .where(inArray(memexes.id, [memexA, memexB, memexC]))
    .catch(() => {});
});

describe("moveDoc — whole-Spec move (dec-2 / dec-3)", () => {
  it("ac-2/ac-10/ac-11/ac-12: every doc-scoped artifact lands in the target; read-state stays", async () => {
    tagAc(ac(2));
    tagAc(ac(10));
    tagAc(ac(11));
    tagAc(ac(12));

    const doc = await createDocDraft(memexA, "Whole Move", "Purpose");
    const section = doc.sections[0];
    const dec = await createDecision(memexA, doc.id, "Decision 1");
    const task = await createTask(memexA, doc.id, "Task 1", "");
    const secComment = await addComment(memexA, section.id, "u", "section comment");
    const decComment = await addDecisionComment(memexA, dec.id, "u", "decision comment");
    const taskComment = await addTaskComment(memexA, task.id, "u", "task comment");

    // Artifacts with no convenient creation service — seeded directly in A.
    const [acRow] = await db
      .insert(acs)
      .values({ memexId: memexA, briefId: doc.id, seq: 1, kind: "scope", statement: "must move" })
      .returning({ id: acs.id });
    const [issueRow] = await db
      .insert(issues)
      .values({ memexId: memexA, docId: doc.id, seq: 1, title: "Bug", body: "b", type: "bug" })
      .returning({ id: issues.id });
    await db.insert(docMembers).values({ memexId: memexA, docId: doc.id, userId, role: "editor" });
    await db.insert(docAssignees).values({ memexId: memexA, docId: doc.id, userId });

    // Per-user / per-Memex read-state — must NOT move (dec-2 / ac-11).
    await db
      .insert(qaReportViews)
      .values({ userId, memexId: memexA })
      .onConflictDoNothing();

    const result = await moveDoc(memexA, doc.id, memexB, ctxFor(userId));

    expect(result.docId).toBe(doc.id);
    expect(result.newHandle).toMatch(/^spec-\d+$/);

    // The doc is gone from A and present in B at its new handle.
    await expect(getDoc(memexA, doc.id)).rejects.toThrow(NotFoundError);
    const fetched = await getDoc(memexB, doc.id);
    expect(fetched.id).toBe(doc.id);
    expect(fetched.handle).toBe(result.newHandle);

    // Every memex_id-bearing doc-scoped artifact now reads memex_id = B.
    const [decRow] = await db.select().from(decisions).where(eq(decisions.id, dec.id));
    expect(decRow.memexId).toBe(memexB);
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskRow.memexId).toBe(memexB);
    const [acAfter] = await db.select().from(acs).where(eq(acs.id, acRow!.id));
    expect(acAfter.memexId).toBe(memexB);
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueRow!.id));
    expect(issueAfter.memexId).toBe(memexB);
    const memberRows = await db.select().from(docMembers).where(eq(docMembers.docId, doc.id));
    expect(memberRows.every((m) => m.memexId === memexB)).toBe(true);
    const assigneeRows = await db.select().from(docAssignees).where(eq(docAssignees.docId, doc.id));
    expect(assigneeRows.every((a) => a.memexId === memexB)).toBe(true);

    // dec-3: ALL comments move — section, decision AND task — unconditionally.
    const commentRows = await db
      .select()
      .from(docComments)
      .where(inArray(docComments.id, [secComment.id, decComment.id, taskComment.id]));
    expect(commentRows).toHaveLength(3);
    expect(commentRows.every((c) => c.memexId === memexB)).toBe(true);

    // ac-11: the read-state row stays in A (not Spec content).
    const [view] = await db
      .select()
      .from(qaReportViews)
      .where(eq(qaReportViews.userId, userId));
    expect(view.memexId).toBe(memexA);
  });

  it("ac-2: active share tokens are revoked on move", async () => {
    tagAc(ac(2));
    const doc = await createDocDraft(memexA, "Share Revoke", "Purpose");
    const token = await createShareToken(memexA, doc.id);
    expect(token.revoked).toBe(false);

    const result = await moveDoc(memexA, doc.id, memexB, ctxFor(userId));
    expect(result.revokedShareTokens).toBe(1);

    const reread = await db.query.shareTokens.findFirst({ where: eq(shareTokens.id, token.id) });
    expect(reread?.revoked).toBe(true);
  });
});

describe("moveDoc — attribution (dec-5 / std-32)", () => {
  it("ac-16: both emitted events carry channel='rest_ui' and the actor", async () => {
    tagAc(ac(16));
    tagAc(ac(6)); // scope: move writes are attributed (channel + actor), never empty ctx
    const doc = await createDocDraft(memexA, "Attributed Move", "Purpose");

    const seen: { memexId: string; channel?: string; actorUserId?: string }[] = [];
    const unsubscribe = bus.subscribe({}, (event) => {
      if (
        event.entity === "document" &&
        (event.memexId === memexA || event.memexId === memexB)
      ) {
        seen.push({
          memexId: event.memexId,
          channel: event.channel,
          actorUserId: event.actorUserId,
        });
      }
    });
    try {
      await moveDoc(memexA, doc.id, memexB, ctxFor(userId));
    } finally {
      unsubscribe();
    }

    const source = seen.find((e) => e.memexId === memexA);
    const target = seen.find((e) => e.memexId === memexB);
    expect(source, `expected source emit; saw ${JSON.stringify(seen)}`).toBeDefined();
    expect(target, `expected target emit; saw ${JSON.stringify(seen)}`).toBeDefined();
    for (const e of [source!, target!]) {
      expect(e.channel).toBe("rest_ui");
      expect(e.actorUserId).toBe(userId);
    }
  });
});

describe("moveDoc — errors (std-7)", () => {
  it("rejects same-memex moves", async () => {
    const doc = await createDocDraft(memexA, "Same Memex", "Purpose");
    await expect(moveDoc(memexA, doc.id, memexA, ctxFor(userId))).rejects.toThrow(ValidationError);
  });

  it("404s when the doc isn't in the source memex", async () => {
    const doc = await createDocDraft(memexA, "Wrong Source", "Purpose");
    await expect(moveDoc(memexB, doc.id, memexA, ctxFor(userId))).rejects.toThrow(NotFoundError);
  });

  it("ac-9: 404s (not 403) when the caller isn't authorized in the target", async () => {
    tagAc(ac(9));
    const doc = await createDocDraft(memexA, "Forbidden Target", "Purpose");
    // memexC: the user is NOT a member. std-7 → 404, never 403.
    await expect(moveDoc(memexA, doc.id, memexC, ctxFor(userId))).rejects.toThrow(NotFoundError);
    // The doc must NOT have moved.
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.memexId).toBe(memexA);
  });

  it("ac-9: 404s when a non-member tries to move", async () => {
    tagAc(ac(9));
    const doc = await createDocDraft(memexA, "Non Member", "Purpose");
    await expect(moveDoc(memexA, doc.id, memexB, ctxFor(outsiderUserId))).rejects.toThrow(
      NotFoundError,
    );
  });
});

// The regression anchor: prove the move works under the PROD runtime posture.
// The whole suite + local dev connect as the table OWNER (RLS-exempt under
// NO FORCE, std-36), so the original bug never reproduced. Here we drop into the
// non-owner `memex_app` role (NOBYPASSRLS, the Cloud Run runtime) and show:
//   (a) the naive cross-tenant UPDATE is rejected by the memex_isolation
//       WITH CHECK — this IS the prod-only 500 (ac-1's failure mode), and
//   (b) move_doc() (SECURITY DEFINER, owner-owned) succeeds where it cannot.
describe("moveDoc — cross-tenant RLS regression (NOBYPASSRLS runtime role)", () => {
  it("ac-1/ac-7: naive UPDATE is RLS-rejected; move_doc() succeeds under memex_app", async () => {
    tagAc(ac(1));
    tagAc(ac(7));
    tagAc(ac(5)); // scope: the test that would have caught the prod bug exists & runs

    const dbUrl =
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
    const appSql = postgres(dbUrl, { max: 1 });
    try {
      // (a) The bug: as memex_app, scoped to A, re-pointing memex_id → B trips
      // the WITH CHECK. This is exactly what 500'd on prod before this Spec.
      const naive = await createDocDraft(memexA, "RLS Naive", "Purpose");
      await expect(
        appSql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE memex_app");
          await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexA]);
          return tx.unsafe("UPDATE documents SET memex_id = $1 WHERE id = $2", [memexB, naive.id]);
        }),
      ).rejects.toThrow();

      // It did not move.
      const [stillA] = await db.select().from(documents).where(eq(documents.id, naive.id));
      expect(stillA.memexId).toBe(memexA);

      // (b) The fix: the SECURITY DEFINER function moves it cleanly under the
      // very same restricted role.
      const moved = await createDocDraft(memexA, "RLS Via Function", "Purpose");
      const rows = (await appSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexA]);
        return tx.unsafe(
          "SELECT new_handle FROM move_doc($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
          [moved.id, memexA, memexB, userId],
        );
      })) as unknown as Array<{ new_handle: string }>;

      expect(rows[0]?.new_handle).toMatch(/^spec-\d+$/);
      const [nowB] = await db.select().from(documents).where(eq(documents.id, moved.id));
      expect(nowB.memexId).toBe(memexB);
    } finally {
      await appSql.end({ timeout: 5 });
    }
  });

  it("ac-8: move_doc is SECURITY DEFINER, owned by the documents table owner, and memex_app holds only EXECUTE", async () => {
    tagAc(ac(8));

    // SECURITY DEFINER + owner == the owner of `documents` (the role RLS exempts
    // under NO FORCE). Comparing to documents' owner avoids hardcoding 'postgres'.
    const [meta] = (await db.execute(sql`
      SELECT p.prosecdef AS security_definer,
             pg_get_userbyid(p.proowner) AS fn_owner,
             pg_get_userbyid(c.relowner) AS table_owner
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_class c
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
       WHERE p.proname = 'move_doc' AND n.nspname = 'public'
         AND c.relname = 'documents' AND cn.nspname = 'public'
    `)) as unknown as Array<{ security_definer: boolean; fn_owner: string; table_owner: string }>;
    expect(meta.security_definer).toBe(true);
    expect(meta.fn_owner).toBe(meta.table_owner);

    // memex_app may EXECUTE move_doc…
    const [priv] = (await db.execute(sql`
      SELECT has_function_privilege('memex_app', 'move_doc(uuid,uuid,uuid,uuid)', 'EXECUTE') AS app_execute,
             has_function_privilege('public',    'move_doc(uuid,uuid,uuid,uuid)', 'EXECUTE') AS public_execute,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'memex_app') AS app_bypassrls,
             (SELECT rolsuper      FROM pg_roles WHERE rolname = 'memex_app') AS app_super
    `)) as unknown as Array<{
      app_execute: boolean;
      public_execute: boolean;
      app_bypassrls: boolean;
      app_super: boolean;
    }>;
    expect(priv.app_execute).toBe(true);
    // …and gains no general cross-tenant power: PUBLIC can't call it, and the
    // runtime role neither bypasses RLS nor is a superuser.
    expect(priv.public_execute).toBe(false);
    expect(priv.app_bypassrls).toBe(false);
    expect(priv.app_super).toBe(false);
  });
});
