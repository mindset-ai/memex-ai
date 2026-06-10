// spec-122 t-5 + t-8 — the WHO resolver wired into a REAL consumer.
//
// ac-25/26 are about RENDERING: a free-form test_events.actor string must show a
// display WHO in the surfaces a user actually sees. The resolver
// (services/who-resolver.ts) has unit coverage, but until it is INVOKED by a
// consumer the capability is unreachable. This exercises it end-to-end through
// the get_doc ACTIVITY footer (craftActivityBlock), the surface that reads the
// activity view's test_events arm (actor_raw):
//
//   ac-25  a free-form actor matching a Memex user's email renders that user's
//          DISPLAY NAME and is attributed under their user_id (so the same
//          identity unifies CI activity with UI activity — proven here by the
//          collision predicate correctly excluding the caller's own CI flips).
//   ac-26  a free-form actor matching NO user renders verbatim, never collapsed
//          to "You" or to a wrong user.
//
// Tagged with tagAc → AC verification is recorded in the Memex workspace. Run
// with MEMEX_EMIT_KEY set (worktree-root .env).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  testEvents,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { craftActivityBlock } from "./tool-specs.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  testEvents: [] as string[],
};

let memexId: string;
let nsSlug: string;
let danaId: string; // a Memex user whose EMAIL doubles as a CI actor string
let danaEmail: string;
let callerId: string; // a DIFFERENT user, the one calling get_doc
let docDana: string; // spec carrying Dana's CI flip (ac-25)
let docCi: string; // spec carrying an unmatched CI flip (ac-26)
let handleDana: string;
let handleCi: string;

async function makeSpec(title: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, "x", "spec");
  created.docs.push(doc.id);
  const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
  return { id: doc.id, handle: row.handle };
}

async function flip(handle: string, actor: string): Promise<void> {
  const acUid = `${nsSlug}/main/specs/${handle}/acs/ac-1`;
  const [te] = await db
    .insert(testEvents)
    .values({ acUid, status: "pass", actor } as typeof testEvents.$inferInsert)
    .returning();
  created.testEvents.push(te.id);
}

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  danaEmail = `dana-${tag}@memex.ai`;
  const [dana] = await db
    .insert(users)
    .values({ email: danaEmail, name: "Dana" } as typeof users.$inferInsert)
    .returning();
  const [caller] = await db
    .insert(users)
    .values({ email: `caller-${tag}@memex.ai`, name: "Mel" } as typeof users.$inferInsert)
    .returning();
  danaId = dana.id;
  callerId = caller.id;
  created.users.push(dana.id, caller.id);

  const [ns] = await db.insert(namespaces).values({ slug: `fwho-${tag}`, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id;
  created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: dana.id, orgId: org.id, role: "administrator" });
  await db.insert(orgMemberships).values({ userId: caller.id, orgId: org.id, role: "administrator" });

  const a = await makeSpec("Dana CI");
  docDana = a.id;
  handleDana = a.handle;
  const b = await makeSpec("Unmatched CI");
  docCi = b.id;
  handleCi = b.handle;

  // ac-25: a CI flip whose actor string IS Dana's email.
  await flip(handleDana, danaEmail);
  // ac-26: a CI flip whose actor matches no Memex user.
  await flip(handleCi, "CI · runner-7");
});

afterAll(async () => {
  if (created.testEvents.length)
    await db.delete(testEvents).where(inArray(testEvents.id, created.testEvents)).catch(() => {});
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("get_doc footer resolves the test_events WHO [spec-122 t-5/t-8]", () => {
  // ── ac-25 ──────────────────────────────────────────────────────────────────
  it("ac-25: a CI actor matching a user's email renders the user's display name", async () => {
    tagAc(`${AC}/ac-25`);
    const block = await craftActivityBlock(memexId, docDana, callerId);
    expect(block, "the footer renders for the spec").toBeTruthy();
    // Resolved to the display NAME, not the raw email.
    expect(block!).toContain("Dana");
    expect(block!, "the raw email is never shown once it resolves").not.toContain(danaEmail);
  });

  it("ac-25: the CI flip is attributed under the user's id — no self-collision for that user", async () => {
    tagAc(`${AC}/ac-25`);
    // Caller IS Dana: her own CI flip resolves to her user_id, so the advisory
    // ("another session is advancing this") must NOT fire — proving the flip is
    // attributed under Dana's id, unifying CI with UI identity.
    const ownView = await craftActivityBlock(memexId, docDana, danaId);
    expect(ownView === null || !ownView.includes("⚠")).toBe(true);

    // A DIFFERENT caller sees Dana named as the advancing actor.
    const otherView = await craftActivityBlock(memexId, docDana, callerId);
    expect(otherView!).toContain("⚠");
    expect(otherView!).toContain("Dana");
  });

  // ── ac-26 ──────────────────────────────────────────────────────────────────
  it("ac-26: a CI actor matching no user renders verbatim, never collapsed", async () => {
    tagAc(`${AC}/ac-26`);
    const block = await craftActivityBlock(memexId, docCi, callerId);
    expect(block!).toContain("CI · runner-7");
    // Never collapsed to "You", and never mis-attributed to the caller as a
    // collision (an unattributable CI string carries no user_id).
    expect(block!).not.toContain("You");
    expect(block === null || !block.includes("⚠")).toBe(true);
  });
});
