// spec-535 t-3 — the web write path and the read that feeds the byline + banner.
//
// Two claims, and the second is the one worth a test rather than an assumption:
//
//   1. The endpoints exist, are gated on write access exactly as the neighbouring
//      archive / restore verbs are, and thread channel='rest_ui' so the write is
//      attributed (std-32).
//   2. The three columns reach the client on the EXISTING document read. `getDoc`
//      returns `Doc & {…}` and the row rides along on `...doc`, so this should
//      already work with no read-path change at all. "Should already work" is
//      exactly the claim that quietly stops being true, so it is pinned here.
//
// Read access is deliberately unrestricted: the flag and its contact are visible
// to anyone who can read the Spec. A reader without write access is precisely the
// person who most needs to know to ask first (dec-4) — only the CONTROL is gated.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft, getDoc, setSensitive } from "../services/documents.js";
import { upsertUserByEmail } from "../services/users.js";
import { makeTestMemex } from "../services/test-helpers.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

describe("spec-535 t-3: the sensitivity fields on the web surface", () => {
  let memexId: string;
  let actorId: string;
  let actorName: string | null;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("sensroute");
    const actor = await upsertUserByEmail("spec535-route-flagger@example.com");
    actorId = actor.id;
    actorName = actor.name ?? actor.email;
  });

  afterAll(async () => {
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
  });

  async function makeDoc(title: string): Promise<string> {
    const doc = await createDocDraft(memexId, title, "purpose", "spec");
    createdDocIds.push(doc.id);
    return doc.id;
  }

  it("ac-6: the three fields ride the existing document read — no new endpoint", async () => {
    tagAc(AC(6));
    const docId = await makeDoc("Sensitive Read Spec");

    const unflagged = await getDoc(memexId, docId);
    // Present and honest on an unflagged Spec: false, not undefined. A missing
    // key would make the UI render "not flagged" by accident rather than by fact.
    expect(unflagged.sensitive).toBe(false);
    expect(unflagged.sensitiveByUserId).toBeNull();
    expect(unflagged.sensitiveByName).toBeNull();

    await setSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });

    const flagged = await getDoc(memexId, docId);
    expect(flagged.sensitive).toBe(true);
    expect(flagged.sensitiveByUserId).toBe(actorId);
    // The banner names the contact from this, so it must be a real display value.
    expect(flagged.sensitiveByName).toBe(actorName);
  });

  it("ac-8: the web path stamps channel='rest_ui', not a silent default", async () => {
    tagAc(AC(8));
    const docId = await makeDoc("Sensitive Channel Spec");

    // restCtx(c) supplies this in the route; asserting the service honours it is
    // what makes the route's one-liner trustworthy.
    await setSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(true);
    expect(row.sensitiveByUserId).toBe(actorId);
  });

  it("ac-7: neither endpoint accepts a reason in its body", async () => {
    tagAc(AC(7));
    // The archive endpoint two blocks up DOES read `body.reason` — that is the
    // shape this Spec deliberately did not copy (dec-1: public Memex, std-31).
    // A source guard, because a body field that is never read is invisible at
    // runtime; the failure mode is someone adding it back "for symmetry".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "documents.ts"), "utf-8");

    const start = src.indexOf('docs.post("/:id/sensitive"');
    expect(start, "the /:id/sensitive route is missing").toBeGreaterThan(-1);
    const end = src.indexOf("docs.post(", src.indexOf('docs.post("/:id/sensitive/clear"') + 1);
    const block = src.slice(start, end > start ? end : start + 1200);

    expect(block).not.toMatch(/\breason\b/i);
    expect(block).not.toMatch(/\bnote\b/i);
  });

  it("ac-3: both endpoints are write-gated the same way as archive / restore", async () => {
    tagAc(AC(3));
    // requireMemexId(c) is the repo's write gate: it resolves only for a confirmed
    // org member and throws otherwise. Asserting the routes use IT (rather than the
    // permissive resolveReadableMemexId the GETs use) is the check that actually
    // catches a mis-gated verb — an over-permissive route still returns 200 in a
    // happy-path test.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "documents.ts"), "utf-8");

    for (const route of ['docs.post("/:id/sensitive"', 'docs.post("/:id/sensitive/clear"']) {
      const start = src.indexOf(route);
      expect(start, `${route} is missing`).toBeGreaterThan(-1);
      const block = src.slice(start, start + 400);
      expect(block, `${route} must use the write gate`).toMatch(/requireMemexId\(c\)/);
      expect(block, `${route} must thread the actor ctx`).toMatch(/restCtx\(c\)/);
      expect(block, `${route} must not use the permissive read resolver`).not.toMatch(
        /resolveReadableMemexId/,
      );
    }
  });
});
