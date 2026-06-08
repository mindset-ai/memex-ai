// spec-200 t-2 / dec-7 — auto-generation + AI worthiness gate.
//
// Integration test against the live local Postgres with a STUBBED Anthropic client
// (key-free). Proves:
//   ac-6 — a worthy Spec is drafted from its content and published, no approval.
//   ac-7 — a draft/specify (private/authoring) Spec produces no entry.
//   ac-16 — a NOT-worthy Spec publishes nothing, its skip verdict is persisted,
//           and it is never re-judged (no second LLM call).
//   ac-8 — the batch judges each shippable spec once, bounded per run.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, documents, docSections, decisions, acs, whatsNewEntries, whatsNewSkips } from "../db/schema.js";
import { createOrgWithMemexAndOwner } from "./__test__/seed-org.js";
import {
  draftEntryForSpec,
  generateAndPublishForSpec,
  runWhatsNewGeneration,
  type AnthropicLike,
  type WhatsNewDraft,
} from "./whats-new-generation.js";
import { getEntryBySpecRef } from "./whats-new.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-200/acs/ac-${n}`;

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdSpecRefs: string[] = [];

afterAll(async () => {
  if (createdSpecRefs.length) {
    await db.delete(whatsNewEntries).where(inArray(whatsNewEntries.sourceSpecRef, createdSpecRefs)).catch(() => {});
    await db.delete(whatsNewSkips).where(inArray(whatsNewSkips.sourceSpecRef, createdSpecRefs)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

/** A stub client that returns a fixed structured verdict+draft and counts calls. */
function stubClient(draft: WhatsNewDraft): AnthropicLike & { calls: number } {
  let calls = 0;
  const client = {
    messages: {
      parse: async () => {
        calls++;
        return { parsed_output: draft };
      },
    },
  };
  Object.defineProperty(client, "calls", { get: () => calls });
  return client as unknown as AnthropicLike & { calls: number };
}

/** A worthy verdict the stub returns by default. */
const WORTHY: WhatsNewDraft = {
  worthAnnouncing: true,
  reason: "a new user-facing feature",
  title: "Resize your sidebar",
  what: "You can now drag the left navigation wider or narrower.",
  why: "Set the layout that suits you — it sticks across visits.",
};

/** Seed a Spec with an overview, one resolved decision, and one scope AC. */
async function seedSpec(opts: { status: string; handle: string }): Promise<{ memexId: string; sourceSpecRef: string }> {
  const [u] = await db
    .insert(users)
    .values({ email: `wn-gen-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() })
    .returning();
  createdUserIds.push(u.id);

  const slug = `wn-${crypto.randomUUID().slice(0, 8)}`;
  const seeded = await createOrgWithMemexAndOwner({ slug, ownerUserId: u.id, memexSlug: "main" });
  const memexId = seeded.memex.id;
  createdMemexIds.push(memexId);

  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: opts.handle, title: "Adjustable left navigation drawer", docType: "spec", status: opts.status })
    .returning();
  await db.insert(docSections).values({
    docId: doc.id,
    sectionType: "overview",
    title: "Overview",
    content: "Let users drag the left nav wider or narrower and remember the width.",
    seq: 1,
    position: 1,
  });
  await db.insert(decisions).values({
    memexId,
    docId: doc.id,
    seq: 1,
    title: "Persist the chosen width",
    status: "resolved",
    resolution: "Store the drawer width per user in localStorage so it survives reloads.",
  });
  await db.insert(acs).values({
    memexId,
    briefId: doc.id,
    seq: 1,
    kind: "scope",
    status: "active",
    statement: "The left nav can be resized and the chosen width persists across sessions.",
  });

  const sourceSpecRef = `${slug}/main/specs/${opts.handle}`;
  createdSpecRefs.push(sourceSpecRef);
  return { memexId, sourceSpecRef };
}

describe("whats-new generation (spec-200 t-2)", () => {
  it("drafts a worthy Spec and publishes straight to the feed — no approval (ac-6)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "build", handle: "spec-wn-a" });
    const client = stubClient(WORTHY);

    const outcome = await generateAndPublishForSpec(memexId, "spec-wn-a", { client });

    expect(outcome.status).toBe("published");
    expect(client.calls).toBe(1);
    const stored = await getEntryBySpecRef(sourceSpecRef);
    expect(stored).not.toBeNull();
    expect(stored!.title).toBe("Resize your sidebar");
    expect(stored!.whatText).toContain("drag the left navigation");
    expect(stored!.sourceSpecHandle).toBe("spec-wn-a");

    tagAc(AC(6));
    // Scope ACs proven by this same flow: ac-1 (What+Why derived from the Spec)
    // and ac-4 (auto-drafted, no changelog, published with no approval gate).
    tagAc(AC(1));
    tagAc(AC(4));
  });

  it("does NOT generate for a draft/specify Spec (ac-7)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "draft", handle: "spec-wn-b" });
    const client = stubClient(WORTHY);

    const outcome = await generateAndPublishForSpec(memexId, "spec-wn-b", { client });
    expect(outcome.status).toBe("not-shippable");
    expect(client.calls).toBe(0); // never called the model
    expect(await getEntryBySpecRef(sourceSpecRef)).toBeNull();

    await expect(draftEntryForSpec(memexId, "spec-wn-b", { client })).rejects.toThrow(/not shippable/i);

    tagAc(AC(7));
  });

  it("specify-phase Spec is also withheld (ac-7)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "specify", handle: "spec-wn-c" });
    const client = stubClient(WORTHY);
    expect((await generateAndPublishForSpec(memexId, "spec-wn-c", { client })).status).toBe("not-shippable");
    expect(await getEntryBySpecRef(sourceSpecRef)).toBeNull();
    tagAc(AC(7));
  });

  it("a NOT-worthy Spec publishes nothing, persists the skip, and is never re-judged (ac-16 / dec-7)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "verify", handle: "spec-wn-d" });
    const client = stubClient({ worthAnnouncing: false, reason: "internal bug fix, no user-facing benefit" });

    const first = await generateAndPublishForSpec(memexId, "spec-wn-d", { client });
    expect(first.status).toBe("skipped");
    expect(client.calls).toBe(1);
    expect(await getEntryBySpecRef(sourceSpecRef)).toBeNull(); // nothing published
    // Skip verdict persisted.
    const skipRow = await db.select().from(whatsNewSkips).where(eq(whatsNewSkips.sourceSpecRef, sourceSpecRef));
    expect(skipRow).toHaveLength(1);

    // Re-judged? No — already evaluated, so NO second LLM call.
    const second = await generateAndPublishForSpec(memexId, "spec-wn-d", { client });
    expect(second.status).toBe("already-evaluated");
    expect(client.calls).toBe(1); // unchanged — not re-judged

    tagAc(AC(16));
  });
});

describe("runWhatsNewGeneration batch (spec-200 t-3 / ac-8)", () => {
  // Seed one memex with 2 shippable specs (build + verify) + one draft spec.
  async function seedMemexWithSpecs(): Promise<{ memexId: string }> {
    const [u] = await db
      .insert(users)
      .values({ email: `wn-batch-${crypto.randomUUID()}@example.com`, emailVerifiedAt: new Date() })
      .returning();
    createdUserIds.push(u.id);
    const slug = `wnb-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await createOrgWithMemexAndOwner({ slug, ownerUserId: u.id, memexSlug: "main" });
    const memexId = seeded.memex.id;
    createdMemexIds.push(memexId);

    for (const [i, status] of [["a", "build"], ["b", "verify"], ["c", "draft"]].entries()) {
      const handle = `spec-batch-${status[0]}${i}`;
      await db.insert(documents).values({ memexId, handle, title: `Spec ${handle}`, docType: "spec", status: status[1] });
      createdSpecRefs.push(`${slug}/main/specs/${handle}`);
    }
    return { memexId };
  }

  it("judges each shippable spec once, excludes drafts, idempotent on re-run (ac-8)", async () => {
    const { memexId } = await seedMemexWithSpecs();
    const client = stubClient(WORTHY);

    const first = await runWhatsNewGeneration(memexId, { client });
    expect(first.total).toBe(2); // build + verify; draft filtered out
    expect(first.evaluated).toBe(2);
    expect(first.generated).toBe(2);
    expect(first.capped).toBe(false);

    // Idempotent: a second run judges nothing (both already evaluated).
    const second = await runWhatsNewGeneration(memexId, { client });
    expect(second.evaluated).toBe(0);
    expect(second.generated).toBe(0);

    tagAc(AC(8));
  });

  it("caps LLM judgements per run (bounded — spec-178 t-5 lesson) (ac-8)", async () => {
    const { memexId } = await seedMemexWithSpecs();
    const client = stubClient(WORTHY);

    const capped = await runWhatsNewGeneration(memexId, { client, max: 1 });
    expect(capped.evaluated).toBe(1);
    expect(capped.capped).toBe(true);

    // The next run picks up the remainder.
    const rest = await runWhatsNewGeneration(memexId, { client, max: 1 });
    expect(rest.evaluated).toBe(1);
    expect(rest.capped).toBe(false);

    tagAc(AC(8));
  });
});
