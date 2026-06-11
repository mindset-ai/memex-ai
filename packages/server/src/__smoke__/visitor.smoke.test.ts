// Post-deploy smoke for the visitor_id seam (spec-254 t-5, std-17).
//
// Real HTTP against a deployed host. The visitorMiddleware now runs on every /api/*
// request as a PURE READER (reads the memex_vid cookie). These checks prove it is
// live and HARMLESS on the deployed host: a request carrying a visitor cookie is
// still served normally and never 5xxs. (The merge populating visitors.user_id is
// exercised by the std-28 e2e journey + the server integration suite against a DB;
// smoke has no DB visibility, so it asserts the live request path only.)

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { SMOKE_BASE_URL, SMOKE_NAMESPACE } from "./smoke-env.js";

// A syntactically valid v4 UUID — what a consented client would carry.
const VID = "11111111-1111-4111-8111-111111111111";

describe(`visitor_id smoke @ ${SMOKE_BASE_URL}`, () => {
  it("GET /api/health with a memex_vid cookie → 200 (middleware is live + harmless)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-254/acs/ac-7");
    const res = await fetch(`${SMOKE_BASE_URL}/api/health`, {
      headers: { cookie: `memex_vid=${VID}` },
    });
    expect(res.status).toBe(200);
  });

  it("POST telemetry with a memex_vid cookie → controlled response, never 5xx", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-254/acs/ac-7");
    const res = await fetch(`${SMOKE_BASE_URL}/api/${SMOKE_NAMESPACE}/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `memex_vid=${VID}` },
      body: JSON.stringify({ name: "spec.create_clicked" }),
    });
    expect(res.status).toBeLessThan(500);
  });
});
