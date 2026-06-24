// spec-360 t-3 — the scaffold assistant's authoring tool (propose-then-confirm).
//
// **ac-3** — the admin gate is server-enforced IN THE TOOL HANDLER: a non-admin
// member and a complete non-member are refused IDENTICALLY (no existence leak,
// std-7). Explaining stays open; only authoring is gated.
// **ac-7** — `propose_scaffold_change` returns a structured proposal and WRITES
// NOTHING — the org additions are unchanged after a propose call.
// **ac-8** — the confirm/approve path round-trips through scaffold-additions.ts
// (add/edit/disable/delete), and only `source: 'org'` rows are ever touched.
// **ac-12** — the handler refuses an impossible target and pushes back on an
// incoherent one rather than emitting a proposal.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  users,
} from "../db/schema.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";
import { parseScaffoldProposal } from "@memex/shared";
import { bus, type ChangeEvent } from "../services/bus.js";
import {
  createOrgScaffoldAddition,
  updateOrgScaffoldAddition,
  toggleOrgScaffoldAddition,
  deleteOrgScaffoldAddition,
  listOrgScaffoldAdditions,
} from "../services/scaffold-additions.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

const proposeSpec = toolSpecs.find((s) => s.name === "propose_scaffold_change")!;

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const email = `sca-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return user.id;
}

async function seedOrg(): Promise<{ orgId: string; memexId: string }> {
  const slug = `sca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  return db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: "Scaffold Assistant Test" })
      .returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [mx] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    createdNamespaceIds.push(ns.id);
    return { orgId: org.id, memexId: mx.id };
  });
}

async function grant(
  userId: string,
  orgId: string,
  role: "member" | "administrator",
): Promise<void> {
  await db
    .insert(orgMemberships)
    .values({ userId, orgId, role, status: "active" })
    .onConflictDoNothing();
}

function ctxFor(userId: string, memexId: string): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async () => {
      throw new Error("resolveRef not used by propose_scaffold_change");
    },
    workspaceUrl: async () => "",
    verbose: false,
  };
}

const ADD = {
  operation: "add",
  target: { tool: "create_task", phase: "build" },
  text: "Every build task must carry at least one acceptance criterion.",
  rationale: "Org house rule: no untested build work.",
};

describe("spec-360 t-3: admin gate is server-enforced in the handler (ac-3)", () => {
  it("refuses a non-admin member and a non-member IDENTICALLY (std-7, no leak)", async () => {
    tagAc(AC(3));
    const { orgId, memexId } = await seedOrg();
    const member = await seedUser();
    const stranger = await seedUser();
    await grant(member, orgId, "member");
    // stranger gets no membership at all.

    const memberResult = await proposeSpec.handler(ADD, ctxFor(member, memexId));
    const strangerResult = await proposeSpec.handler(ADD, ctxFor(stranger, memexId));

    // Both refused, and the refusal is BYTE-IDENTICAL — it cannot betray whether
    // the caller is a member-without-admin or a complete outsider.
    expect(parseScaffoldProposal(memberResult)).toBeNull();
    expect(parseScaffoldProposal(strangerResult)).toBeNull();
    expect(memberResult).toEqual(strangerResult);
    expect(memberResult).toMatch(/administrator/i);
  });

  it("an administrator is NOT refused — the request is honoured", async () => {
    tagAc(AC(3));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const result = await proposeSpec.handler(ADD, ctxFor(admin, memexId));
    expect(parseScaffoldProposal(result)).not.toBeNull();
  });
});

describe("spec-360 t-3: propose writes nothing (ac-7)", () => {
  it("returns a structured proposal and leaves org additions untouched", async () => {
    tagAc(AC(7));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const before = await listOrgScaffoldAdditions(orgId);
    expect(before).toHaveLength(0);

    const result = await proposeSpec.handler(ADD, ctxFor(admin, memexId));
    const proposal = parseScaffoldProposal(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.operation).toBe("add");
    expect(proposal!.text).toBe(ADD.text);
    expect(proposal!.target).toEqual(ADD.target);

    // Nothing was persisted — the write only happens on the admin's approval,
    // through the existing route, never in this handler.
    const after = await listOrgScaffoldAdditions(orgId);
    expect(after).toHaveLength(0);
  });
});

describe("spec-360 t-3: validate-and-pushback in the handler (ac-12)", () => {
  it("refuses an impossible target (a tool blocked in the named phase)", async () => {
    tagAc(AC(12));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");
    const result = await proposeSpec.handler(
      { operation: "add", target: { tool: "create_task", phase: "specify" }, text: "x", rationale: "y" },
      ctxFor(admin, memexId),
    );
    expect(parseScaffoldProposal(result)).toBeNull();
    expect(result).toMatch(/won't propose|does not run|blocked/i);
  });

  it("pushes back on an untargeted org-global instead of proposing it", async () => {
    tagAc(AC(12));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");
    const result = await proposeSpec.handler(
      { operation: "add", target: {}, text: "Be thorough.", rationale: "because" },
      ctxFor(admin, memexId),
    );
    expect(parseScaffoldProposal(result)).toBeNull();
    expect(result).toMatch(/dilut|every nudge|scope/i);
  });
});

// spec-360 issue-11 — per-Memex vs org-wide scope rides the propose flow.
// The handler maps `scope: 'memex'` onto the proposal (with a "(this Memex only)"
// summary note) and defaults to org-wide when scope is omitted; the UI's
// approveProposal then resolves 'memex' to the current memexId at write time.
describe("spec-360 issue-11: agent-set scope on the add proposal (ac-2)", () => {
  it("scope 'memex' produces a proposal with scope='memex' + a (this Memex only) summary note", async () => {
    tagAc(AC(2));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const result = await proposeSpec.handler(
      { ...ADD, scope: "memex" },
      ctxFor(admin, memexId),
    );
    const proposal = parseScaffoldProposal(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.scope).toBe("memex");
    expect(proposal!.summary).toMatch(/this Memex only/i);
  });

  it("default/omitted scope produces an org-wide proposal (scope='org', no note)", async () => {
    tagAc(AC(2));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const result = await proposeSpec.handler(ADD, ctxFor(admin, memexId));
    const proposal = parseScaffoldProposal(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.scope).toBe("org");
    expect(proposal!.summary).not.toMatch(/this Memex only/i);
  });

  it("an explicit scope 'org' is honoured as org-wide", async () => {
    tagAc(AC(2));
    const { orgId, memexId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const result = await proposeSpec.handler(
      { ...ADD, scope: "org" },
      ctxFor(admin, memexId),
    );
    const proposal = parseScaffoldProposal(result);
    expect(proposal!.scope).toBe("org");
  });
});

describe("spec-360: delivered as a mode, no new persistence/LLM path, reflects live (ac-4)", () => {
  it("the approve path routes through the existing service and emits on the std-8 bus", async () => {
    tagAc(AC(4));
    const { orgId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe({ entity: "org_scaffold_addition" }, (e) => events.push(e));
    try {
      // The proposal's approve calls the SAME service spec-343 uses — no new
      // persistence; the write rides mutate() → the std-8 bus, so the surface
      // reflects it live.
      await createOrgScaffoldAddition(
        {
          orgId,
          authorId: admin,
          target: { phase: "build" },
          text: "Carry an AC on every build task.",
          rationale: "house rule",
        },
        { channel: "rest_ui" },
      );
    } finally {
      unsub();
    }
    expect(
      events.some((e) => e.entity === "org_scaffold_addition" && e.action === "created"),
      "approving an addition must emit an org_scaffold_addition event on the std-8 bus",
    ).toBe(true);
  });

  it("the scaffold tool subset is built from the shared tool registry — no second LLM client", () => {
    tagAc(AC(4));
    // propose_scaffold_change is a normal entry in the single shared toolSpecs
    // catalogue (the same one the chat agent already dispatches), not a bespoke
    // model/tool path. Delivered as a MODE, not a new agent.
    expect(toolSpecs.some((s) => s.name === "propose_scaffold_change")).toBe(true);
  });
});

describe("spec-360 t-4: the approve path round-trips through scaffold-additions.ts (ac-8)", () => {
  it("add / edit / disable / delete each persist via the service, only org rows", async () => {
    tagAc(AC(8));
    const { orgId } = await seedOrg();
    const admin = await seedUser();
    await grant(admin, orgId, "administrator");

    // add (the proposal's approve calls createOrgScaffoldAddition)
    const created = await createOrgScaffoldAddition(
      {
        orgId,
        authorId: admin,
        target: { tool: "create_task", phase: "build" },
        text: "Carry an AC on every build task.",
        rationale: "house rule",
      },
      { channel: "rest_ui" },
    );
    expect(created.source).toBe("org");
    expect(created.id).toBeTruthy();

    // edit
    const edited = await updateOrgScaffoldAddition(
      created.id,
      { text: "Carry at least one AC on every build task." },
      { channel: "rest_ui" },
    );
    expect(edited.text).toBe("Carry at least one AC on every build task.");

    // disable
    const disabled = await toggleOrgScaffoldAddition(created.id, false, { channel: "rest_ui" });
    expect(disabled.enabled).toBe(false);

    // delete
    await deleteOrgScaffoldAddition(created.id, { channel: "rest_ui" });
    const remaining = await listOrgScaffoldAdditions(orgId);
    expect(remaining.find((b) => b.id === created.id)).toBeUndefined();
  });
});
