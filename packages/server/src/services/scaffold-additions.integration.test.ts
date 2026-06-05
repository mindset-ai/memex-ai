// Integration tests for b-68 t-3 — per-Org scaffold guidance additions.
//
// Verifies the dec-2 field shape (ac-7), the mutate + std-8 bus wiring
// (ac-8), and the dec-3 "no path to base" invariant at the service layer
// (ac-11). Adds cascade-delete + filtering coverage so the surface is
// exercised end-to-end against a real Postgres.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  namespaces,
  orgs,
  memexes,
  orgScaffoldAdditions,
} from "../db/schema.js";
import { bus, type ChangeEvent } from "./bus.js";
import { upsertUserByEmail } from "./users.js";
import {
  createOrgScaffoldAddition,
  deleteOrgScaffoldAddition,
  getOrgScaffoldAddition,
  listOrgScaffoldAdditions,
  toggleOrgScaffoldAddition,
  updateOrgScaffoldAddition,
} from "./scaffold-additions.js";
import { NotFoundError } from "../types/errors.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;
const AC103 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-103/acs/ac-${n}`;

interface TestOrg {
  orgId: string;
  namespaceId: string;
  memexId: string;
  authorId: string;
}

// Per-test fresh org so cascade-delete tests don't poison neighbours.
async function makeTestOrg(prefix: string): Promise<TestOrg> {
  const slug = `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase().slice(0, 39);
  const result = await db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });
  const user = await upsertUserByEmail(`scaffold-addition-${slug}@memex.test`);
  return {
    orgId: result.org.id,
    namespaceId: result.ns.id,
    memexId: result.memex.id,
    authorId: user.id,
  };
}

// Collect every bus event during a callback. We subscribe with an empty
// filter so cross-org events don't leak into the assertion; each test scopes
// its expectation to its own org/memex.
async function collectBusEventsDuring<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; events: ChangeEvent[] }> {
  const events: ChangeEvent[] = [];
  const unsubscribe = bus.subscribe({}, (e) => events.push(e));
  try {
    const result = await fn();
    return { result, events };
  } finally {
    unsubscribe();
  }
}

// Holds the orgs created in this file so afterAll() can prune them
// regardless of which `it()` was last.
const createdOrgIds: string[] = [];

afterAll(async () => {
  for (const orgId of createdOrgIds) {
    // Namespace cascade nukes org → memex → org_scaffold_additions.
    await db
      .delete(namespaces)
      .where(
        eq(
          namespaces.id,
          (
            await db.query.orgs.findFirst({
              where: eq(orgs.id, orgId),
              columns: { namespaceId: true },
            })
          )?.namespaceId ?? "00000000-0000-0000-0000-000000000000",
        ),
      )
      .catch(() => {});
  }
});

// ── ac-7: dec-2 GuidanceBlock field shape (round-trip persistence) ───────

describe("round-trip persistence — dec-2 field shape (ac-7)", () => {
  let fx: TestOrg;
  beforeAll(async () => {
    fx = await makeTestOrg("rt");
    createdOrgIds.push(fx.orgId);
  });

  it("create + read back surfaces every GuidanceBlock field set by the caller", async () => {
    tagAc(AC(7));

    const created = await createOrgScaffoldAddition(
      {
        orgId: fx.orgId,
        authorId: fx.authorId,
        target: { phase: "build", tool: "create_task" },
        text: "Link the AC ref in every test body.",
        rationale: "Untagged tests are invisible to Memex.",
        emphasis: "do",
        enabled: true,
        order: 3,
      },
      { channel: "rest_ui" },
    );

    // Surface-level field check (the field shape ships from the create path).
    expect(created.kind).toBe("guidance_block");
    expect(created.source).toBe("org");
    expect(typeof created.id).toBe("string");
    expect(created.target).toEqual({ phase: "build", tool: "create_task" });
    expect(created.text).toBe("Link the AC ref in every test body.");
    expect(created.rationale).toBe("Untagged tests are invisible to Memex.");
    expect(created.emphasis).toBe("do");
    expect(created.enabled).toBe(true);
    expect(created.order).toBe(3);
    expect(created.orgId).toBe(fx.orgId);
    expect(created.authorId).toBe(fx.authorId);
    expect(typeof created.createdAt).toBe("string");
    expect(typeof created.updatedAt).toBe("string");

    // Read back from the DB and assert the same shape (independent of the
    // create path's in-memory return value).
    const fetched = await getOrgScaffoldAddition(created.id);
    expect(fetched).toEqual(created);
  });

  it("treats empty target as org-global (all three columns NULL)", async () => {
    tagAc(AC(7));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: {},
      text: "ORG-GLOBAL: every Spec must cite a Linear ticket.",
      rationale: "Internal traceability rule.",
    });

    expect(created.target).toEqual({});
    expect(created.emphasis).toBeUndefined();
    expect(created.enabled).toBe(true); // default
    expect(created.order).toBe(0); // default
  });

  // ── spec-103 ac-10: target_button dimension round-trips ────────────────
  it("persists target.button into the migrated target_button column and round-trips it", async () => {
    tagAc(AC103(10));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { button: "verify-spec" },
      text: "Append to the verify-spec Prompt Button.",
      rationale: "Org-specific verification checklist.",
    });

    // Create path surfaces target.button.
    expect(created.target).toEqual({ button: "verify-spec" });

    // Raw column was written (independent of the read-mapping layer).
    const dbRow = await db.query.orgScaffoldAdditions.findFirst({
      where: eq(orgScaffoldAdditions.id, created.id),
    });
    expect(dbRow?.targetButton).toBe("verify-spec");
    expect(dbRow?.targetPhase).toBeNull();
    expect(dbRow?.targetTool).toBeNull();
    expect(dbRow?.targetTransition).toBeNull();

    // Read path round-trips it back into a GuidanceBlock with target.button.
    const fetched = await getOrgScaffoldAddition(created.id);
    expect(fetched.kind).toBe("guidance_block");
    expect(fetched.source).toBe("org");
    expect(fetched.target.button).toBe("verify-spec");
    expect(fetched).toEqual(created);
  });
});

// ── ac-8: mutate() + std-8 bus emission ──────────────────────────────────

describe("mutate + bus emission (ac-8)", () => {
  let fx: TestOrg;
  beforeAll(async () => {
    fx = await makeTestOrg("bus");
    createdOrgIds.push(fx.orgId);
  });

  it("create emits org_scaffold_addition.created on the std-8 bus", async () => {
    tagAc(AC(8));

    const { result, events } = await collectBusEventsDuring(() =>
      createOrgScaffoldAddition({
        orgId: fx.orgId,
        authorId: fx.authorId,
        target: { phase: "plan" },
        text: "Plan-phase: confirm scope ACs exist.",
        rationale: "Catches missing scope-AC specs early.",
      }),
    );

    const created = events.find(
      (e) =>
        e.entity === "org_scaffold_addition" &&
        e.action === "created" &&
        e.memexId === fx.memexId,
    );
    expect(
      created,
      `expected an org_scaffold_addition.created event for memex ${fx.memexId}; ` +
        `saw ${JSON.stringify(events.map((e) => ({ entity: e.entity, action: e.action })))}`,
    ).toBeDefined();
    // The result surface carries the row id and the orgId; subscribers
    // (projection cache in t-11) resolve orgId from the emitted memexId via
    // namespace ownership, so the std-8 event itself stays bare.
    expect(result.orgId).toBe(fx.orgId);
    expect(typeof result.id).toBe("string");
  });

  it("update emits org_scaffold_addition.updated", async () => {
    tagAc(AC(8));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { tool: "create_decision" },
      text: "ORIGINAL",
      rationale: "Original rationale.",
    });

    const { events } = await collectBusEventsDuring(() =>
      updateOrgScaffoldAddition(created.id, { text: "EDITED" }),
    );

    const updated = events.find(
      (e) =>
        e.entity === "org_scaffold_addition" &&
        e.action === "updated" &&
        e.memexId === fx.memexId,
    );
    expect(updated).toBeDefined();

    // Confirm the actual write landed.
    const reloaded = await getOrgScaffoldAddition(created.id);
    expect(reloaded.text).toBe("EDITED");
    expect(created.text).toBe("ORIGINAL");
  });

  it("toggle emits org_scaffold_addition.updated and flips enabled", async () => {
    tagAc(AC(8));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "verify" },
      text: "Verify-phase guidance.",
      rationale: "Why verify matters.",
      enabled: true,
    });

    const { result, events } = await collectBusEventsDuring(() =>
      toggleOrgScaffoldAddition(created.id, false),
    );

    expect(result.enabled).toBe(false);
    const toggled = events.find(
      (e) =>
        e.entity === "org_scaffold_addition" &&
        e.action === "updated" &&
        e.memexId === fx.memexId,
    );
    expect(toggled).toBeDefined();
  });

  it("delete emits org_scaffold_addition.deleted and removes the row", async () => {
    tagAc(AC(8));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { transition: "build" },
      text: "BUILD-RUBRIC org check.",
      rationale: "Internal gate prose.",
    });

    const { events } = await collectBusEventsDuring(() =>
      deleteOrgScaffoldAddition(created.id),
    );

    const deleted = events.find(
      (e) =>
        e.entity === "org_scaffold_addition" &&
        e.action === "deleted" &&
        e.memexId === fx.memexId,
    );
    expect(deleted).toBeDefined();

    // The row is gone.
    await expect(getOrgScaffoldAddition(created.id)).rejects.toThrow(NotFoundError);
  });
});

// ── ac-11: every row read is source: 'org' — no path to base ─────────────

describe("dec-3: service has no path to source: 'base' (ac-11)", () => {
  let fx: TestOrg;
  beforeAll(async () => {
    fx = await makeTestOrg("dec3");
    createdOrgIds.push(fx.orgId);
  });

  it("create + read always surfaces source: 'org' (the table IS the discriminator)", async () => {
    tagAc(AC(11));

    const created = await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "build" },
      text: "build guidance",
      rationale: "why",
    });
    expect(created.source).toBe("org");

    const list = await listOrgScaffoldAdditions(fx.orgId);
    expect(list).toHaveLength(1);
    expect(list[0]!.source).toBe("org");

    // Drift sentinel: there is no `source` column on the on-disk row, so the
    // service maps every row to `source: 'org'` in code. If anyone added a
    // base-mutation path this would still surface "org" because the column
    // doesn't exist — exactly the dec-3 invariant.
    const raw = await db.query.orgScaffoldAdditions.findFirst({
      where: eq(orgScaffoldAdditions.orgId, fx.orgId),
    });
    expect(raw).toBeDefined();
    expect("source" in (raw as object)).toBe(false);
  });
});

// ── Listing filters ──────────────────────────────────────────────────────

describe("listOrgScaffoldAdditions filters", () => {
  let fx: TestOrg;
  beforeAll(async () => {
    fx = await makeTestOrg("list");
    createdOrgIds.push(fx.orgId);

    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "plan" },
      text: "enabled-1",
      rationale: "r1",
      enabled: true,
      order: 1,
    });
    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "plan" },
      text: "disabled-1",
      rationale: "r2",
      enabled: false,
      order: 2,
    });
    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "plan" },
      text: "enabled-2",
      rationale: "r3",
      enabled: true,
      order: 3,
    });
  });

  it("returns every row when no filters applied, ordered by display_order", async () => {
    const list = await listOrgScaffoldAdditions(fx.orgId);
    expect(list.map((b) => b.text)).toEqual(["enabled-1", "disabled-1", "enabled-2"]);
  });

  it("enabledOnly: true excludes disabled rows", async () => {
    const list = await listOrgScaffoldAdditions(fx.orgId, { enabledOnly: true });
    expect(list.map((b) => b.text)).toEqual(["enabled-1", "enabled-2"]);
    for (const b of list) expect(b.enabled).toBe(true);
  });
});

// ── Cascade delete ───────────────────────────────────────────────────────

describe("cascade delete", () => {
  it("deleting the org removes its scaffold additions (ON DELETE CASCADE)", async () => {
    const fx = await makeTestOrg("cas");
    // NB: deliberately not pushing to createdOrgIds — we delete it ourselves.

    await createOrgScaffoldAddition({
      orgId: fx.orgId,
      authorId: fx.authorId,
      target: { phase: "draft" },
      text: "to be cascaded",
      rationale: "transient",
    });

    const before = await db
      .select()
      .from(orgScaffoldAdditions)
      .where(eq(orgScaffoldAdditions.orgId, fx.orgId));
    expect(before).toHaveLength(1);

    // Deleting the namespace cascades through org → org_scaffold_additions.
    await db.delete(namespaces).where(eq(namespaces.id, fx.namespaceId));

    const after = await db
      .select()
      .from(orgScaffoldAdditions)
      .where(eq(orgScaffoldAdditions.orgId, fx.orgId));
    expect(after).toHaveLength(0);
  });
});
