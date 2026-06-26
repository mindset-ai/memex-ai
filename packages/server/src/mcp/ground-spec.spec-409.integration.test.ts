// spec-409 — integration tests for the code-grounded flag: the `ground_spec`
// MCP tool (presence checks + provenance + activity event), assess_spec reading
// the persisted flag, the specify→build gate verdict, and read-time staleness.
//
// Harness mirrors assessment-tools.integration.test.ts: a per-suite actor with
// its own namespace/org/memex, the `_registeredTools` introspection trick for
// MCP calls, and direct service calls where we assert structured results.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  acs,
  activityLog,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import {
  createDocDraft,
  groundSpec,
  getDoc,
} from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { assessPhaseTransition } from "../services/phase-assessment.js";
import { startActivityLogSink, _stopActivityLogSink } from "../services/activity-log.js";
import { ValidationError } from "../types/errors.js";

// Bus dispatch → activity_log insert is a detached promise; poll briefly.
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 25): Promise<T> {
  let last = await fn();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 40));
    last = await fn();
  }
  return last;
}

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-409/acs/ac-${n}`;

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

afterAll(async () => {
  _stopActivityLogSink();
  if (created.docs.length) {
    await db.delete(activityLog).where(inArray(activityLog.briefId, created.docs)).catch(() => {});
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function setupActor() {
  const sub = `g409-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `ground-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, account: m, nsSlug: ns.slug };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const refFor = (nsSlug: string, handle: string) => `${nsSlug}/main/specs/${handle}`;

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor();
  startActivityLogSink();
});

async function newSpec(title: string) {
  const m = await createDocDraft(actor.account.id, title, "purpose", "spec");
  created.docs.push(m.id);
  return m;
}

describe("spec-409 ground_spec tool + flag", () => {
  it("is registered as an MCP tool", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names).toContain("ground_spec");
  });

  it("refuses to ground without codebase_present (ac-9)", async () => {
    tagAc(AC(9));
    const spec = await newSpec("NoFlag");
    const res = await callTool(actor.user.id, "ground_spec", { ref: refFor(actor.nsSlug, spec.handle) });
    expect(res.isError).toBe(true);
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.groundedInCode).toBe(false);
  });

  it("refuses to ground when codebase_present is false (ac-9)", async () => {
    tagAc(AC(9));
    const spec = await newSpec("FalseFlag");
    const res = await callTool(actor.user.id, "ground_spec", {
      ref: refFor(actor.nsSlug, spec.handle),
      codebase_present: false,
    });
    expect(res.isError).toBe(true);
  });

  it("refuses to ground over a non-mcp channel (ac-8)", async () => {
    tagAc(AC(8));
    const spec = await newSpec("WrongChannel");
    await expect(
      groundSpec(actor.account.id, spec.id, { actorUserId: actor.user.id, channel: "in_app_agent" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.groundedInCode).toBe(false);
  });

  it("grounds with codebase_present, stamping who/when provenance (ac-2, ac-3, ac-7)", async () => {
    tagAc(AC(2));
    tagAc(AC(3));
    tagAc(AC(7));
    const spec = await newSpec("Grounded");
    const res = await callTool(actor.user.id, "ground_spec", {
      ref: refFor(actor.nsSlug, spec.handle),
      codebase_present: true,
    });
    expect(res.isError).toBeFalsy();
    const [row] = await db.select().from(documents).where(eq(documents.id, spec.id));
    expect(row.groundedInCode).toBe(true);
    expect(row.groundedAt).toBeInstanceOf(Date);
    expect(row.groundedByUserId).toBe(actor.user.id);
    // name denormalised at write — actor has no name, so it falls back to email.
    expect(row.groundedByName).toBe(actor.user.email);
  });

  it("denormalised groundedByName survives a later rename (ac-7)", async () => {
    tagAc(AC(7));
    const spec = await newSpec("RenameProof");
    await callTool(actor.user.id, "ground_spec", {
      ref: refFor(actor.nsSlug, spec.handle),
      codebase_present: true,
    });
    const before = (await db.select().from(documents).where(eq(documents.id, spec.id)))[0];
    await db.update(users).set({ name: "Renamed Person" }).where(eq(users.id, actor.user.id));
    const after = (await db.select().from(documents).where(eq(documents.id, spec.id)))[0];
    expect(after.groundedByName).toBe(before.groundedByName); // unchanged by the rename
    await db.update(users).set({ name: null }).where(eq(users.id, actor.user.id));
  });

  it("emits a document activity_log event on grounding (ac-11)", async () => {
    tagAc(AC(11));
    const spec = await newSpec("ActivityEvent");
    await callTool(actor.user.id, "ground_spec", {
      ref: refFor(actor.nsSlug, spec.handle),
      codebase_present: true,
    });
    const events = await poll(
      () =>
        db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.briefId, spec.id), like(activityLog.narrative, "grounded%"))),
      (rows) => rows.length >= 1,
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].entity).toBe("document");
    expect(events[0].channel).toBe("mcp");
    expect(events[0].actorUserId).toBe(actor.user.id);
  });
});

describe("spec-409 assess_spec reads the persisted flag + gate (ac-12, ac-13)", () => {
  it("grounded Spec → gate 'grounded', no code-grounding prompt (ac-12)", async () => {
    tagAc(AC(12));
    const spec = await newSpec("AssessGrounded");
    await groundSpec(actor.account.id, spec.id, { actorUserId: actor.user.id, channel: "mcp" });
    const assessment = await assessPhaseTransition(actor.account.id, spec.id, "build");
    expect(assessment.groundingGate).toBe("grounded");
    expect(assessment.codeGroundingPromptPending).toBeFalsy();
  });

  it("ungrounded Spec → gate 'blocked' and a pending prompt (ac-13)", async () => {
    tagAc(AC(13));
    const spec = await newSpec("AssessBlocked");
    const assessment = await assessPhaseTransition(actor.account.id, spec.id, "build");
    expect(assessment.groundingGate).toBe("blocked");
    expect(assessment.codeGroundingPromptPending).toBe(true);
  });

  it("ungrounded + not_applicable override → gate 'not_applicable' (ac-13)", async () => {
    tagAc(AC(13));
    const spec = await newSpec("AssessOverride");
    const assessment = await assessPhaseTransition(actor.account.id, spec.id, "build", "not_applicable");
    expect(assessment.groundingGate).toBe("not_applicable");
  });
});

describe("spec-409 read-time staleness (ac-10)", () => {
  it("fresh grounding is not stale; a later decision makes it stale, flag untouched (ac-10)", async () => {
    tagAc(AC(10));
    const spec = await newSpec("Staleness");
    await groundSpec(actor.account.id, spec.id, { actorUserId: actor.user.id, channel: "mcp" });

    const fresh = await getDoc(actor.account.id, spec.id);
    expect(fresh.groundedInCode).toBe(true);
    expect(fresh.groundedStale).toBe(false);

    // A decision created after groundedAt is a change since grounding.
    await createDecision(actor.account.id, spec.id, "A new fork after grounding");

    const drifted = await getDoc(actor.account.id, spec.id);
    expect(drifted.groundedStale).toBe(true);
    // The persisted flag is NOT mutated by the staleness computation.
    expect(drifted.groundedInCode).toBe(true);
  });
});
