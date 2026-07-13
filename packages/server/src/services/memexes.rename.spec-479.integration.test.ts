// spec-479 (t-2) — renameMemexSlug / updateMemexName services + the D-4
// reuse-guard.
//
//   • renameMemexSlug changes memexes.slug AND writes a memex_rename redirect
//     (`<ns>/<old>` → `<ns>/<new>`) atomically, so old URLs forward instead of
//     404ing (std-10 §7 / ac-8).
//   • The D-4 reuse-guard (ac-9): once a slug is the source of a live redirect,
//     isMemexSlugAvailable reports it unavailable and a rename back onto it is
//     rejected — a fresh Memex can never shadow the outstanding redirect.
//   • updateMemexName changes only the display name — no slug/URL change.
//
// Per-worker-unique fixtures via makeTestMemex (std-37); redirect rows created
// by these tests are cleaned up afterEach (std-39 hygiene).

import { describe, it, expect, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  getMemexById,
  renameMemexSlug,
  updateMemexName,
  isMemexSlugAvailable,
} from "./memexes.js";
import { lookupRedirect } from "./redirects.js";

const AC_479_RENAME_SERVICE =
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-8";
const AC_479_REUSE_GUARD =
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-9";

// Namespace slugs whose redirect rows we must sweep after each test.
const nsSlugsToClean: string[] = [];

afterEach(async () => {
  while (nsSlugsToClean.length) {
    const nsSlug = nsSlugsToClean.pop()!;
    await db.execute(sql`
      DELETE FROM redirects
       WHERE old_path LIKE ${nsSlug + "/%"}
          OR old_path = ${nsSlug}
          OR new_path LIKE ${nsSlug + "/%"}
    `);
  }
});

// Build a fresh org memex and return its id + namespace slug + current slug.
async function freshMemex(prefix: string) {
  const memexId = await makeTestMemex(prefix);
  const memex = await getMemexById(memexId);
  if (!memex) throw new Error("fixture memex not found");
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
    columns: { slug: true },
  });
  if (!ns) throw new Error("fixture namespace not found");
  nsSlugsToClean.push(ns.slug);
  return { memexId, nsSlug: ns.slug, slug: memex.slug };
}

describe("renameMemexSlug (spec-479 t-2)", () => {
  it("renames the slug and forwards every old URL via a memex_rename redirect", async () => {
    tagAc(AC_479_RENAME_SERVICE);
    const { memexId, nsSlug, slug: oldSlug } = await freshMemex("mxr");

    await renameMemexSlug(memexId, "renamed", { channel: "rest_ui" });

    const after = await getMemexById(memexId);
    expect(after?.slug).toBe("renamed");

    // A deep old path forwards to the new slug, suffix preserved.
    const result = await lookupRedirect(`${nsSlug}/${oldSlug}/specs/spec-1/tasks/t-1`);
    expect(result).toEqual({
      redirected: `${nsSlug}/renamed/specs/spec-1/tasks/t-1`,
    });
  });

  it("rejects renaming to the current slug (no self-redirect)", async () => {
    tagAc(AC_479_RENAME_SERVICE);
    const { memexId, slug } = await freshMemex("mxs");
    await expect(renameMemexSlug(memexId, slug, {})).rejects.toThrow(
      /same as the current slug|nothing to rename/i,
    );
  });

  it("D-4 reuse-guard: a redirected slug is unavailable and can't be re-registered", async () => {
    tagAc(AC_479_REUSE_GUARD);
    const { memexId, nsSlug, slug: oldSlug } = await freshMemex("mxg");

    await renameMemexSlug(memexId, "moved", { channel: "rest_ui" });

    // The old slug is now the source of a live redirect → unavailable.
    const avail = await isMemexSlugAvailable(
      (await getMemexById(memexId))!.namespaceId,
      oldSlug,
    );
    expect(avail).toEqual({ available: false, reason: "redirected" });

    // And renaming back onto it is blocked (would shadow the redirect).
    await expect(renameMemexSlug(memexId, oldSlug, {})).rejects.toThrow(
      /reserved by a redirect/i,
    );

    // Sanity: nsSlug used above to satisfy the cleanup sweep.
    expect(nsSlug).toBeTruthy();
  });
});

describe("updateMemexName (spec-479 t-2)", () => {
  it("changes the display name only — slug and URLs are untouched", async () => {
    tagAc(AC_479_RENAME_SERVICE);
    const { memexId, nsSlug, slug } = await freshMemex("mxn");

    await updateMemexName(memexId, "Renamed Display", { channel: "rest_ui" });

    const after = await getMemexById(memexId);
    expect(after?.name).toBe("Renamed Display");
    expect(after?.slug).toBe(slug); // slug unchanged

    // No redirect was written for a name-only change.
    const result = await lookupRedirect(`${nsSlug}/${slug}/specs/spec-1`);
    expect(result).toEqual({ notFound: true });
  });

  it("rejects an empty name", async () => {
    tagAc(AC_479_RENAME_SERVICE);
    const { memexId } = await freshMemex("mxe");
    await expect(updateMemexName(memexId, "   ", {})).rejects.toThrow(
      /cannot be empty/i,
    );
  });
});
