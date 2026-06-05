// Post-deploy smoke — spec-167: the OAuth consent "Allow" button is legible.
//
// std-17: a change that touches a user-facing surface (the consent screen) must
// extend the smoke suite. This is the HTTP-observable proxy for "the Allow button
// is legible on the DEPLOYED consent screen" (ac-6): the served CSS bundle must
// define `--color-on-accent` for BOTH themes AND carry the generated
// `.text-on-accent` utility. The original bug was that `text-on-accent` resolved
// to NOTHING (token undefined → no rule emitted → text fell back to the muted
// body colour at ~1.5:1). If that regresses, this fails over real HTTP.
//
// Runs against SMOKE_BASE_URL via `make smoke-int` / `make smoke-prod`.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { SMOKE_BASE_URL } from "./smoke-env.js";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-167/acs/ac-6";

describe(`oauth consent Allow-button legibility smoke @ ${SMOKE_BASE_URL}`, () => {
  it("deployed CSS bundle defines on-accent (both themes) + the .text-on-accent utility (spec-167 ac-6)", async () => {
    tagAc(AC6);

    // 1. The SPA index references a content-hashed CSS bundle. Fetch an app
    //    route, NOT `/` — on prod the apex root 301s to the marketing site
    //    (std-2 topology) with an empty body. The SPA fallback serves the
    //    shell with HTTP 404 for client-side routes on both envs, so the
    //    assertion is on the body (the property under test is the CSS bundle,
    //    not the route's status code).
    const indexRes = await fetch(`${SMOKE_BASE_URL}/login`);
    expect([200, 404]).toContain(indexRes.status);
    const html = await indexRes.text();
    const ref = html.match(/\/assets\/index-[\w-]+\.css/);
    expect(ref, "the SPA shell should reference a hashed CSS bundle").toBeTruthy();

    // 2. Fetch the actual deployed stylesheet.
    const cssRes = await fetch(`${SMOKE_BASE_URL}${ref![0]}`);
    expect(cssRes.status).toBe(200);
    const css = await cssRes.text();

    // 3. The token must be defined for BOTH themes (dark slate-900 / light white).
    expect(css).toMatch(/--color-on-accent:\s*15\s+23\s+42/); // dark / slate-900
    expect(css).toMatch(/--color-on-accent:\s*255\s+255\s+255/); // light / white

    // 4. Tailwind must have GENERATED the utility (the bug was that it hadn't).
    expect(css).toMatch(
      /\.text-on-accent\{[^}]*color:rgb\(var\(--color-on-accent\)/,
    );
  });
});
