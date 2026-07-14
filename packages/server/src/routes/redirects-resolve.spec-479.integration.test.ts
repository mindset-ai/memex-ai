// spec-479 t-6 (dec-5) — GET /api/redirects/resolve lets the statically-served
// SPA forward a stale tenant PAGE url after a rename (the browser never reaches
// the server's redirect handler). Public, unauth: it resolves a path string via
// lookupRedirect; the destination's own access control still applies when the
// browser navigates there (std-10 cl-100/101).

import { describe, it, expect, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { app } from "../app.js";
import { db } from "../db/connection.js";
import { namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { getMemexById, renameMemexSlug } from "../services/memexes.js";

const AC_479_RESOLVE =
  "mindset-prod/memex-building-itself/specs/spec-479/acs/ac-11";

const nsSlugsToClean: string[] = [];
afterEach(async () => {
  while (nsSlugsToClean.length) {
    const s = nsSlugsToClean.pop()!;
    await db
      .execute(
        sql`DELETE FROM redirects WHERE old_path LIKE ${s + "/%"} OR new_path LIKE ${s + "/%"}`,
      )
      .catch(() => {});
  }
});

function resolve(path: string) {
  return app.request(
    `/api/redirects/resolve?path=${encodeURIComponent(path)}`,
    { headers: { Host: "memex.ai", Accept: "application/json" } },
  );
}

describe("GET /api/redirects/resolve (spec-479 t-6)", () => {
  it("resolves a stale tenant path to its post-rename path", async () => {
    tagAc(AC_479_RESOLVE);
    const memexId = await makeTestMemex("resolve");
    const memex = await getMemexById(memexId);
    const ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.id, memex!.namespaceId),
      columns: { slug: true },
    });
    nsSlugsToClean.push(ns!.slug);
    await renameMemexSlug(memexId, "renamed", { channel: "rest_ui" });

    const res = await resolve(`/${ns!.slug}/main/specs/spec-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      redirected: `/${ns!.slug}/renamed/specs/spec-1`,
    });
  });

  it("returns notFound for a path with no redirect", async () => {
    tagAc(AC_479_RESOLVE);
    const res = await resolve(`/no-such-ns-479/no-mx/specs/spec-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notFound: true });
  });

  it("returns notFound for an empty path", async () => {
    tagAc(AC_479_RESOLVE);
    const res = await resolve("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notFound: true });
  });
});
