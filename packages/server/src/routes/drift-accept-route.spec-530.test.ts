// spec-530 t-4 / dec-6 (ac-24) — there is exactly ONE way to accept a proposal, and no
// mounted surface that pretends to be another.
//
// `POST /api/drift/proposals/:commentId/accept` was built as spec-63's t-12. It applied
// a proposal with `updateSection`, which has thrown on every Standard since spec-161
// made them clause-backed — and a `plan_revision` only ever exists on a Standard. So it
// could not succeed on any real proposal, and no client ever called it (spec-143 dec-3
// removed the buttons that used to).
//
// A reachable endpoint that always throws is the same defect this whole Spec exists to
// fix, in a different medium: it looks authoritative, and only running it reveals it is
// dead. This session nearly reasoned from it — spec-530's own Overview asserted no such
// route existed, and that had to be corrected in s-3. So the assertion is 404 (route
// absent), not "refuses with a nice message".

import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../middleware/session.js", async () => {
  const { createMiddleware } = await import("hono/factory");
  return {
    sessionMiddleware: createMiddleware(async (_c: unknown, next: () => Promise<void>) =>
      next(),
    ),
  };
});

import driftRouter from "./drift.js";
import { makeTestAppWithTenant } from "./route-test-helpers.js";

const AC_24 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-24";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeApp() {
  const app = makeTestAppWithTenant({ memexId: "00000000-0000-0000-0000-000000000001" });
  app.route("/api/drift", driftRouter);
  return app;
}

describe("spec-530 dec-6: the dead accept route is gone (ac-24)", () => {
  it("POST /api/drift/proposals/:id/accept is not routed at all — 404, not 500", async () => {
    tagAc(AC_24);
    const res = await makeApp().request(
      "/api/drift/proposals/11111111-1111-1111-1111-111111111111/accept",
      { method: "POST" },
    );

    // 404 means Hono has no handler for the path. A mounted-but-refusing endpoint
    // would answer 4xx-with-a-body from inside a handler, which is exactly the
    // misleading state dec-6 removed.
    expect(res.status).toBe(404);
  });

  it("no longer imports updateSection — the call that made it dead on arrival", () => {
    tagAc(AC_24);
    const source = readFileSync(resolve(HERE, "drift.ts"), "utf8");

    // The import and the CALL are the fingerprints — not the word. The file's header
    // deliberately still explains what `updateSection` was and why it could never
    // work, because that history is the reason this route must not come back; an
    // assertion that forbade the name would delete the explanation along with the bug.
    expect(source).not.toMatch(/from "\.\.\/services\/sections\.js"/);
    expect(source).not.toMatch(/\bupdateSection\s*\(/);
    // And the route registration itself is gone, not merely commented out.
    expect(source).not.toMatch(/drift\.post\(/);
  });

  it("GET /api/drift still serves the Inbox — only the accept path was removed", async () => {
    tagAc(AC_24);
    const res = await makeApp().request("/api/drift");
    // Whatever the read path answers (it hits the DB), it must not be "no such route".
    expect(res.status).not.toBe(404);
  });
});
