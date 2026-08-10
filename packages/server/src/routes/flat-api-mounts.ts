// spec-515 t-6 / dec-7 — flat `/api/<root>` mounts and their tenant-parsing
// exemption, declared in one place.
//
// THE PROBLEM THIS CLOSES. `memexResolver` runs before routing and reads any
// `/api/<a>/<b>` as a tenant address. A flat mount whose root is not exempt has its
// SUBPATHS swallowed: the resolver looks up a namespace that doesn't exist and
// returns 404 per std-7 before the router runs. The bare mount still works (one
// segment fails the length check), so the defect is invisible until someone hits a
// subpath — which is how `/api/email/unsubscribe` stayed dead for 27 days and
// `/api/test-events/batch` silently disabled spec-489's batching.
//
// Six recurrences under review-based enforcement (`stripe`, `postmark`, `internal`
// each carry a comment describing this exact failure) is the evidence that a
// hand-synced pair of lists does not hold.
//
// HOW IT WORKS. `mountFlatApi` refuses to mount a root that is not declared below.
// The mistake therefore stops the server at boot instead of producing a route that
// mounts cleanly and 404s in production. Adding a mount is still two edits, but the
// second one cannot be forgotten — omit it and nothing starts.
//
// WHY NOT A LIST app.ts ITERATES (dec-7 option C, rejected). Hono matches in
// registration ORDER, so position is behaviour. `/api/orgs` is mounted at two points
// ~78 lines apart with unrelated mounts between; `/api/docs` and `/api/me` carry
// several routers; `/api/llm` and `/api/telemetry` need an `app.use` registered
// first; `/api/oauth` is conditional. A flat ordered table cannot express that
// without making route ordering a data concern in a security-relevant path.
//
// WHY NOT HONO'S ROUTE TABLE (dec-1, rejected). Reading `app.routes` couples tenant
// routing to a framework internal that can reshape in a minor release, and the
// resolver is registered before the mounts so it would need lazy evaluation. This
// declaration is ours and is static.
//
// The root DECLARATION lives in `api-roots.ts` (zero imports) because the
// reserved-slug list needs it too and must not pull `db/connection` in through
// the resolver. This module owns only the mounting mechanism.

import type { Hono } from "hono";
import { FLAT_API_MOUNT_ROOTS } from "./api-roots.js";


/**
 * Mount one or more routers flat at `/api/<root>`, and assert the root is declared
 * above so it is exempt from tenant parsing.
 *
 * Call it exactly where the `app.route(...)` calls used to sit — order, arity,
 * middleware pairing and conditionality are all preserved by leaving the call
 * sites in place. Calling it twice with the same root is expected (`/api/orgs`,
 * `/api/docs`, `/api/me` all do).
 *
 * @throws if `root` is not in {@link FLAT_API_MOUNT_ROOTS} — deliberately at module
 * evaluation, i.e. server boot, so an undeclared mount can never reach production.
 */
export function mountFlatApi(
  // `Hono` is generic over its env; the app's own bindings are irrelevant here and
  // pinning them would force every caller to thread type args through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  root: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...routers: Hono<any, any, any>[]
): void {
  if (!FLAT_API_MOUNT_ROOTS.has(root)) {
    throw new Error(
      `mountFlatApi: "${root}" is not a declared flat API mount root. ` +
        "Add it to FLAT_API_MOUNT_ROOTS in routes/flat-api-mounts.ts — without that, " +
        "memexResolver reads /api/" +
        root +
        "/<rest> as namespace=" +
        root +
        " and every subpath 404s before the router runs (spec-515).",
    );
  }
  if (routers.length === 0) {
    throw new Error(`mountFlatApi: no router passed for "/api/${root}".`);
  }
  for (const router of routers) {
    app.route(`/api/${root}`, router);
  }
}
