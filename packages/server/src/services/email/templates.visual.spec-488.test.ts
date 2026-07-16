// spec-488 t-3 — visual/structural snapshot of the welcome v2 layout. Locks the
// two things unit copy-tests don't: (1) the v2 email leads with the greeting and
// carries NO <h1>; (2) the video thumbnail is the ONLY image and is table-safe
// (bulletproof <img> attributes that survive Outlook/Gmail). Tagged to ac-4.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildWelcomeEmail } from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-488/acs/ac-${n}`;

const welcome = buildWelcomeEmail({
  to: "a@b.test",
  appUrl: "https://int.memex.ai",
  firstName: "Ada",
});
const html = welcome.html ?? "";

describe("spec-488 — welcome v2 visual layout (ac-4)", () => {
  it("is a valid standalone HTML doc rendered through the shared table layout", () => {
    tagAc(AC(4));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('role="presentation"');
    // solid brand-blue CTA, never a gradient (shared-renderer treatment)
    expect(html).toContain("background:#0482DC;color:#FFFFFF");
    expect(html).not.toContain("linear-gradient");
  });

  it("leads with the greeting — the wordmark is followed by a body paragraph, no <h1>", () => {
    tagAc(AC(4));
    expect(html).not.toContain("<h1");
    expect(html).toMatch(/>Memex AI<\/div>\s*<p[^>]*>Hi Ada,/);
  });

  it("the video thumbnail is the ONLY image and is table-safe (bulletproof <img>)", () => {
    tagAc(AC(4));
    // exactly one <img> in the whole email
    expect(html.match(/<img/g) ?? []).toHaveLength(1);
    // bulletproof attributes: kills Outlook's link border, forces block display,
    // explicit dimensions so clients reserve the box, retina via srcset.
    expect(html).toContain('width="480" height="269"');
    expect(html).toContain("display:block;width:100%;max-width:480px;height:auto;border:0;outline:none");
    expect(html).toContain(' 2x"'); // srcset retina descriptor
    // the img is wrapped in a border-stripped anchor to the video (clickable, no
    // stray link chrome in Outlook)
    expect(html).toMatch(/<a href="[^"]*\.mp4[^"]*"[^>]*border:0;outline:none[^>]*>\s*<img/);
  });
});
