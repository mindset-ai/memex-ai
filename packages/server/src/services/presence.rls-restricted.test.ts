// spec-440 t-6 (ac-4) — the PRESENCE RLS-rejection regression, under the restricted
// `memex_app` role (runs ONLY under vitest.rls.config.ts, RLS-subject). This is the
// test the prod bug needed: in the owner-connection default suite RLS is bypassed, so
// markPresent succeeds regardless of the ambient tenant context and the defect is
// invisible. Under memex_app the presence policy is enforced, so a context/row mismatch
// fails exactly as it did in prod — and the fix (markPresent establishes its own tenant
// context) is provable by OUTCOME, in CI, on a laptop.
//
// The prod error (memex-ai-prod Cloud Run logs, 2026-06-30 14:xx–15:21 cluster):
//   [spec-traffic] presence heartbeat failed: ... insert into "presence" ...
//     on conflict ("doc_id","actor_user_id","channel","client_id") do update ...
//   cause: PostgresError: new row violates row-level security policy
//          (USING expression) for table "presence"
// Root cause: markPresent wrote memex_id = input.memexId (the TARGET doc's memex) while
// the ambient app.memex_id was the request's CURRENT memex — a cross-memex mismatch on
// the observeSpecTraffic (spec-traffic.ts) agent path. The presence policy's USING runs
// against the existing row on the ON CONFLICT DO UPDATE branch, so a repeat heartbeat
// from a mismatched context is rejected — swallowed by the caller's try/catch. The fix
// wraps the write in runWithMemexId(input.memexId) so the tenant context always matches
// the row it writes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import { presence, documents, namespaces, users } from "../db/schema.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { markPresent } from "./presence.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-440/acs";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdMemexIds: string[] = [];
const createdDocIds: string[] = [];

async function makeUserWithMemex(tag: string): Promise<{ userId: string; memexId: string }> {
  const user = await upsertUserByEmail(
    `spec440-presence-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  );
  createdUserIds.push(user.id);
  // namespace + memex are NOT RLS-gated — writable by memex_app without a tenant GUC.
  const created = await ensureUserNamespace(user.id);
  createdMemexIds.push(created.memex.id);
  const [ns] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(and(eq(namespaces.ownerUserId, user.id), eq(namespaces.kind, "user")))
    .limit(1);
  if (ns) createdNamespaceIds.push(ns.id);
  return { userId: user.id, memexId: created.memex.id };
}

// The TARGET memex (whose doc the heartbeat is FOR) and a DIFFERENT memex used as the
// mismatched ambient context (standing in for "the request's current memex").
let targetMemexId: string;
let otherMemexId: string;
let targetDocId: string;
let actorUserId: string;

beforeAll(async () => {
  const target = await makeUserWithMemex("target");
  targetMemexId = target.memexId;
  actorUserId = target.userId;

  const other = await makeUserWithMemex("other");
  otherMemexId = other.memexId;

  // The target Spec doc lives in targetMemex — `documents` is gated, so create it under
  // the matching tenant context.
  const doc = await runWithMemexId(targetMemexId, async () =>
    createDocDraft(targetMemexId, "spec440 presence target", "", "spec"),
  );
  targetDocId = doc.id;
  createdDocIds.push(doc.id);
});

afterAll(async () => {
  // Best-effort — the per-worker clone is dropped/recreated every run anyway. Gated
  // deletes (presence/documents) run under the target tenant context so USING is satisfied.
  await runWithMemexId(targetMemexId, async () => {
    await db.delete(presence).where(eq(presence.memexId, targetMemexId)).catch(() => {});
    if (createdDocIds.length) {
      await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
    }
  });
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("spec-440 t-6 — presence heartbeat under the restricted memex_app role", () => {
  it("ac-4: a repeat heartbeat from a MISMATCHED ambient context still updates (the prod onConflictDoUpdate USING rejection)", async () => {
    tagAc(`${AC}/ac-4`);

    const channel = "mcp" as const;
    const clientId = "mcp";

    // Seed the EXISTING presence row under the CORRECT context — the first/browser
    // heartbeat that legitimately created the row. Direct insert so the seed does not
    // depend on the fix under test.
    await runWithMemexId(targetMemexId, async () => {
      await db
        .insert(presence)
        .values({
          memexId: targetMemexId,
          docId: targetDocId,
          actorUserId,
          actorKind: "mcp_agent",
          channel,
          clientId,
        })
        .onConflictDoNothing();
    });
    const before = await runWithMemexId(targetMemexId, async () =>
      db
        .select({ id: presence.id, lastSeenAt: presence.lastSeenAt })
        .from(presence)
        .where(and(eq(presence.docId, targetDocId), eq(presence.channel, channel), eq(presence.clientId, clientId))),
    );
    expect(before.length, "the existing row is seeded").toBe(1);

    // The agent-path heartbeat: markPresent for the TARGET memex while the ambient
    // context is a DIFFERENT memex. This is the exact prod failure without the fix —
    // the ON CONFLICT DO UPDATE's USING runs against the existing row (memex_id =
    // target) under app.memex_id = other → "violates row-level security policy (USING
    // expression) for table presence". With the fix markPresent establishes
    // runWithMemexId(input.memexId) and the update lands.
    let caught: unknown;
    await runWithMemexId(otherMemexId, async () => {
      try {
        await markPresent({
          memexId: targetMemexId,
          docId: targetDocId,
          actorUserId,
          actorKind: "mcp_agent",
          channel,
          clientId,
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(
      caught,
      `markPresent must not fail under a mismatched ambient context; got: ${
        (caught as Error)?.message ?? ""
      } / ${((caught as Error)?.cause as Error | undefined)?.message ?? ""}`,
    ).toBeUndefined();

    // Still exactly one row, owned by the target memex, and last_seen_at was bumped by
    // the DO UPDATE.
    const after = await runWithMemexId(targetMemexId, async () =>
      db
        .select({ id: presence.id, memexId: presence.memexId, lastSeenAt: presence.lastSeenAt })
        .from(presence)
        .where(and(eq(presence.docId, targetDocId), eq(presence.channel, channel), eq(presence.clientId, clientId))),
    );
    expect(after.length, "the upsert updated in place, not inserted a second row").toBe(1);
    expect(after[0]!.memexId).toBe(targetMemexId);
    expect(
      after[0]!.lastSeenAt.getTime(),
      "the heartbeat bumped last_seen_at",
    ).toBeGreaterThanOrEqual(before[0]!.lastSeenAt.getTime());
  });

  it("ac-4: a first heartbeat from a mismatched ambient context still inserts (WITH CHECK path)", async () => {
    tagAc(`${AC}/ac-4`);

    // A channel with no prior row → fresh INSERT. Ambient = the other memex (mismatch).
    // Without the fix the INSERT's WITH CHECK rejects (memex_id != app.memex_id); with
    // it, markPresent runs under runWithMemexId(target) and the row lands.
    const channel = "in_app_agent" as const;
    const clientId = "in_app_agent";

    let caught: unknown;
    await runWithMemexId(otherMemexId, async () => {
      try {
        await markPresent({
          memexId: targetMemexId,
          docId: targetDocId,
          actorUserId,
          actorKind: "in_app_agent",
          channel,
          clientId,
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(
      caught,
      `first markPresent must not fail under a mismatched ambient context; got: ${
        (caught as Error)?.message ?? ""
      } / ${((caught as Error)?.cause as Error | undefined)?.message ?? ""}`,
    ).toBeUndefined();

    const rows = await runWithMemexId(targetMemexId, async () =>
      db
        .select({ id: presence.id, memexId: presence.memexId })
        .from(presence)
        .where(and(eq(presence.docId, targetDocId), eq(presence.channel, channel), eq(presence.clientId, clientId))),
    );
    expect(rows.length, "the fresh heartbeat inserted a row").toBe(1);
    expect(rows[0]!.memexId).toBe(targetMemexId);
  });
});
