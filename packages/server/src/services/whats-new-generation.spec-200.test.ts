// spec-200 t-2 — auto-generation of a What's New entry from a Spec.
//
// Unit/integration test against the live local Postgres with a STUBBED Anthropic
// client (key-free). Seeds a Spec (overview + resolved decision + scope AC), then
// proves:
//   ac-6 — draft-from-spec is written straight to the feed (no approval path).
//   ac-7 — a draft/specify (private/authoring) Spec produces NO entry.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, documents, docSections, decisions, acs, whatsNewEntries } from "../db/schema.js";
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
    await db
      .delete(whatsNewEntries)
      .where(inArray(whatsNewEntries.sourceSpecRef, createdSpecRefs))
      .catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

/** A stub client that returns a fixed structured draft and counts calls. */
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

/** Seed a Spec with an overview, one resolved decision, and one scope AC. */
async function seedSpec(opts: { status: string; handle: string }): Promise<{
  memexId: string;
  sourceSpecRef: string;
}> {
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
  it("drafts What/Why from a shipped Spec and writes straight to the feed — no approval (ac-6)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "build", handle: "spec-wn-a" });
    const client = stubClient({
      title: "Resize your sidebar",
      what: "You can now drag the left navigation wider or narrower.",
      why: "Set the layout that suits you — it sticks across visits.",
    });

    const published = await generateAndPublishForSpec(memexId, "spec-wn-a", { client });

    expect(published).not.toBeNull();
    expect(client.calls).toBe(1);
    // It went straight to the published feed — no pending/approval indirection.
    const stored = await getEntryBySpecRef(sourceSpecRef);
    expect(stored).not.toBeNull();
    expect(stored!.title).toBe("Resize your sidebar");
    expect(stored!.whatText).toContain("drag the left navigation");
    expect(stored!.whyText).toContain("sticks across visits");
    expect(stored!.sourceSpecHandle).toBe("spec-wn-a");

    tagAc(AC(6));
    // Scope ACs proven by this same flow: ac-1 (each entry states What+Why,
    // derived from the Spec) and ac-4 (auto-drafted, no hand-authored changelog,
    // published with no approval gate).
    tagAc(AC(1));
    tagAc(AC(4));
  });

  it("does NOT generate an entry for a draft/specify Spec (ac-7)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "draft", handle: "spec-wn-b" });
    const client = stubClient({ title: "x", what: "x", why: "x" });

    // The resilient publish path returns null and writes nothing.
    const published = await generateAndPublishForSpec(memexId, "spec-wn-b", { client });
    expect(published).toBeNull();
    expect(client.calls).toBe(0); // never even called the model
    expect(await getEntryBySpecRef(sourceSpecRef)).toBeNull();

    // The lower-level draft fn throws for a non-shippable Spec.
    await expect(draftEntryForSpec(memexId, "spec-wn-b", { client })).rejects.toThrow(/not shippable/i);

    tagAc(AC(7));
  });

  it("specify-phase Spec is also withheld (ac-7)", async () => {
    const { memexId, sourceSpecRef } = await seedSpec({ status: "specify", handle: "spec-wn-c" });
    const client = stubClient({ title: "x", what: "x", why: "x" });
    expect(await generateAndPublishForSpec(memexId, "spec-wn-c", { client })).toBeNull();
    expect(await getEntryBySpecRef(sourceSpecRef)).toBeNull();
    tagAc(AC(7));
  });
});

describe("runWhatsNewGeneration batch (spec-200 t-3 / ac-8)", () => {
  // Seed one memex with N shippable specs + one draft spec, all in that memex.
  async function seedMemexWithSpecs(): Promise<{ memexId: string; refPrefix: string }> {
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
      await db
        .insert(documents)
        .values({ memexId, handle, title: `Spec ${handle}`, docType: "spec", status: status[1] });
      createdSpecRefs.push(`${slug}/main/specs/${handle}`);
    }
    return { memexId, refPrefix: `${slug}/main/specs/` };
  }

  it("publishes one entry per shippable spec, excludes drafts, and is idempotent on re-run (ac-8)", async () => {
    const { memexId } = await seedMemexWithSpecs();
    const client = stubClient({ title: "T", what: "W.", why: "Y." });

    const first = await runWhatsNewGeneration(memexId, { client });
    // Two shippable specs (build + verify); the draft is filtered out before the loop.
    expect(first.total).toBe(2);
    expect(first.generated).toBe(2);
    expect(first.capped).toBe(false);

    // Idempotent: a second run drafts nothing (all already published).
    const second = await runWhatsNewGeneration(memexId, { client });
    expect(second.generated).toBe(0);
    expect(second.skipped).toBe(2);

    tagAc(AC(8));
  });

  it("caps the number generated per run (bounded — spec-178 t-5 lesson) (ac-8)", async () => {
    const { memexId } = await seedMemexWithSpecs();
    const client = stubClient({ title: "T", what: "W.", why: "Y." });

    const capped = await runWhatsNewGeneration(memexId, { client, max: 1 });
    expect(capped.generated).toBe(1);
    expect(capped.capped).toBe(true);

    // The next run picks up the remainder.
    const rest = await runWhatsNewGeneration(memexId, { client, max: 1 });
    expect(rest.generated).toBe(1);
    expect(rest.capped).toBe(false);

    tagAc(AC(8));
  });
});
