// spec-515 t-9 / ac-12 — post-deploy proof that every flat `/api/<root>` mount is
// actually REACHABLE on the deployed host.
//
// THIS IS THE GUARD THAT WOULD HAVE CAUGHT JULY. The other layers cannot: in the
// July incident the code was correct, committed, and present in the running image
// (`dist/routes/test-events.js:457`), and the route still 404'd. A green local suite
// says nothing about it, because the defect lives in the composition of a global
// middleware with a route and only manifests over a real HTTP request to a real
// deployment. Had this check existed, `/api/test-events/batch` would have failed the
// 2026-07-21 deploy instead of being found on 2026-07-27, and
// `/api/email/unsubscribe` would have failed on 2026-07-01 instead of sitting dead
// for 27 days.
//
// WHAT IT ASSERTS, AND WHY NOT THE OBVIOUS THING. Not the status code, and not the
// body. `{"error":"Not found"}` is emitted by at least six code paths, so a router
// legitimately reporting "no such id" is byte-identical to the resolver swallowing
// the route — measured during t-2, where `/api/issues/x` and an unmounted control
// root returned the same bytes. Instead it asserts the resolver's positive
// exemption marker (dec-6): `x-memex-tenant: exempt` means "this request was
// recognised as a non-tenant API root and passed through", which is exactly the
// claim. Its ABSENCE on a root that should have it is the failure.
//
// Public tier: unauthenticated, non-destructive, no credentials, so it always runs
// (std-17) — and per std-26 gotcha #8 it must not be one of the skipped ones. It
// touches no namespace or memex.

import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { reservedApiRoots, TENANT_EXEMPT_HEADER } from "../routes/api-roots.js";
import { SMOKE_BASE_URL } from "./smoke-env.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-12";
const AC_NOLEAK = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-17";

// Driven from the shared declaration, never a hardcoded list — a root added to
// api-roots.ts is covered by this check the day it lands, with no second edit.
// That property is the whole point of spec-515; hardcoding here would reintroduce
// the hand-sync this Spec exists to remove.
const ROOTS = [...reservedApiRoots()].sort();

describe(`flat /api mount reachability smoke @ ${SMOKE_BASE_URL}`, () => {
  it("carries the exemption marker on every reserved API root", async () => {
    tagAc(AC);
    // A guard on the guard: if the declaration were somehow empty, an all-pass loop
    // would report safety it never checked.
    expect(ROOTS.length).toBeGreaterThan(20);

    const unreachable: string[] = [];
    for (const root of ROOTS) {
      // A path with a segment after the root, so the resolver would parse it as
      // `<namespace>/<memex>` if the root were NOT exempt. `probe` is a plain slug
      // on purpose: an identifier with underscores would fail the slug grammar and
      // no-op the resolver for the wrong reason, making the check pass vacuously.
      const res = await fetch(`${SMOKE_BASE_URL}/api/${root}/probe`, {
        redirect: "manual",
      });
      if (res.headers.get(TENANT_EXEMPT_HEADER) !== "exempt") {
        unreachable.push(`${root} (status ${res.status})`);
      }
    }
    // Named, not counted, so a failure says WHICH mount is swallowed.
    expect(unreachable).toEqual([]);
  });

  it("does not mark a tenant path — std-7 non-enumeration holds on the deployed host", async () => {
    tagAc(AC_NOLEAK);
    // A namespace that does not exist. The marker must be absent, so this response
    // stays indistinguishable from a private-but-existing memex.
    const res = await fetch(
      `${SMOKE_BASE_URL}/api/zzz-spec515-absent/zzz-absent/docs`,
      { redirect: "manual" },
    );
    expect(res.headers.get(TENANT_EXEMPT_HEADER)).toBeNull();
  });
});
