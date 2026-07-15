// /api/redirects/* — page-path redirect resolution for the statically-served
// SPA (spec-479 dec-5).
//
// Browser page loads are served from the CDN bucket, so they never reach the
// server's `app.use("*")` redirect handler. After a rename the SPA can hit a
// stale tenant path (`/<ns>/<old-mx>/...`); this endpoint lets it ask the server
// "where does this path resolve now?" and forward the user client-side.
//
// PUBLIC / unauth by design: it resolves a path string only. Per std-10
// cl-100/101 path-existence may leak; the destination's own access control
// still applies when the browser actually navigates there.

import { Hono } from "hono";
import { lookupRedirect } from "../services/redirects.js";

export const redirectsRouter = new Hono();

// GET /api/redirects/resolve?path=<ns>/<mx>/... →
//   { redirected: "/<ns>/<new-mx>/..." }  when a rename/move redirect matches
//   { notFound: true }                    otherwise (and for empty/malformed input)
// The stored `old_path` carries no leading slash; we strip the caller's and
// re-add one to the result so the SPA gets a router-ready absolute path.
redirectsRouter.get("/resolve", async (c) => {
  const path = (c.req.query("path") ?? "").replace(/^\/+/, "").trim();
  if (!path) return c.json({ notFound: true } as const);

  // lookupRedirect throws on a corrupt chain (cycle / runaway depth) — treat
  // that as "no usable redirect" rather than surfacing a 500 to the browser.
  const result = await lookupRedirect(path).catch(
    () => ({ notFound: true }) as const,
  );
  if ("redirected" in result) {
    return c.json({ redirected: `/${result.redirected}` });
  }
  return c.json({ notFound: true } as const);
});
