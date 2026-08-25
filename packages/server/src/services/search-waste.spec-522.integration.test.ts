// spec-522 t-4 — the per-search waste is gone (dec-5).
//
// A settled ⌘K keystroke burst used to issue roughly ten database queries. Two of
// them bought nothing at all:
//
//   1. `attachOpenComments` ran unconditionally, and the palette never rendered
//      the result — `openComments` is read by exactly one consumer in the whole
//      codebase, the agent-facing markdown formatter.
//   2. `loadMemexSlugs` ran TWICE, concurrently, for the same single row, because
//      searchMemex and resolveJumpTo each loaded it independently and the route
//      runs both. An `@name` query made it three.
//
// WHY THE SLUG TEST USES A SENTINEL RATHER THAN COUNTING QUERIES. Counting
// statements means reaching into drizzle's internals to stringify SQL objects,
// which is brittle and tests the plumbing rather than the behaviour. Passing
// slugs that are deliberately WRONG proves the same thing more directly: the
// returned paths can only carry the sentinel if the callee used what it was
// handed and did not go and load the real row.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { addComment } from "./comments.js";
import { searchMemex, resolveJumpTo } from "./memex-search.js";
import type { MemexSlugs } from "./memex-search/types.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

/** Deliberately not this memex's real slugs. If a callee ignores the hint and
 *  loads its own, the paths below will carry the real namespace instead and the
 *  assertion fails loudly. */
const SENTINEL_SLUGS: MemexSlugs = {
  namespace_slug: "zzz-sentinel-ns",
  memex_slug: "zzz-sentinel-mx",
};

let memexId: string;
let devUserId: string;
let docHandle: string;

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s522waste");
  memexId = made.memexId;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;

  const doc = await createDocDraft(
    memexId,
    "Wastrel search overhead notes",
    "Wastrel content about redundant queries and discarded payloads.",
    "spec",
    undefined,
    undefined,
    devUserId,
    REST,
  );
  createdDocIds.push(doc.id);
  docHandle = doc.handle;

  // An OPEN comment on the doc's first section — without one, "no indicator
  // attached" would pass whether or not the code ran, which proves nothing.
  const sections = await db.query.docSections.findMany({
    where: (s, { eq }) => eq(s.docId, doc.id),
  });
  const first = sections[0];
  if (!first) throw new Error("expected the seeded doc to have a section");
  await addComment(memexId, first.id, "Dev", "Wastrel open comment", {
    ...REST,
  } as never);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-522 — the open-comment indicator is opt-in (ac-17)", () => {
  it("is NOT attached by default — the ⌘K path stops paying for it", async () => {
    tagAc(AC(17));
    const hits = await searchMemex(memexId, "wastrel", { disableVector: true });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.openComments).toBeUndefined();
    }
  });

  it("IS attached when the caller opts in — the MCP formatter path is unaffected", async () => {
    tagAc(AC(17));
    const hits = await searchMemex(memexId, "wastrel", {
      disableVector: true,
      withOpenComments: true,
    });

    const withIndicator = hits.filter((h) => h.openComments);
    expect(withIndicator.length).toBeGreaterThan(0);
    expect(withIndicator[0].openComments?.count).toBeGreaterThan(0);
  });

  it("the handle short-circuit honours the same flag", async () => {
    tagAc(AC(17));
    // The short-circuit returns before the arms run and had its own
    // attachOpenComments call, so it needed gating separately.
    const off = await searchMemex(memexId, docHandle, { disableVector: true });
    const on = await searchMemex(memexId, docHandle, {
      disableVector: true,
      withOpenComments: true,
    });

    expect(off.length).toBe(1);
    expect(off[0].openComments).toBeUndefined();
    expect(on.length).toBe(1);
    expect(on[0].openComments?.count).toBeGreaterThan(0);
  });
});

describe("spec-522 — the memex slugs are resolved once per request (ac-18)", () => {
  it("searchMemex uses caller-supplied slugs instead of loading its own", async () => {
    tagAc(AC(18));
    const hits = await searchMemex(memexId, "wastrel", {
      disableVector: true,
      slugs: SENTINEL_SLUGS,
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.path).toContain("zzz-sentinel-ns/zzz-sentinel-mx/");
    }
  });

  it("resolveJumpTo uses caller-supplied slugs instead of loading its own", async () => {
    tagAc(AC(18));
    const hits = await resolveJumpTo(memexId, docHandle, SENTINEL_SLUGS);

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.path).toContain("zzz-sentinel-ns/zzz-sentinel-mx/");
    }
  });

  it("both still load their own slugs when the caller supplies none", async () => {
    tagAc(AC(18));
    // The hint is an optimisation, not a requirement — every caller other than
    // the search route omits it and must keep working unchanged.
    const hits = await searchMemex(memexId, "wastrel", { disableVector: true });
    const jump = await resolveJumpTo(memexId, docHandle);

    expect(hits.length).toBeGreaterThan(0);
    expect(jump.length).toBeGreaterThan(0);
    for (const hit of [...hits, ...jump]) {
      expect(hit.path).not.toContain("zzz-sentinel");
    }
  });
});
