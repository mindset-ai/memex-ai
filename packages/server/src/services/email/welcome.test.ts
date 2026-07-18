// spec-488 t-1 — the welcome email v2 copy (supersedes spec-428's Option-3),
// tagged to its scope ACs. The video thumbnail (ac-2/ac-3/ac-7) lands in t-2;
// this file covers the copy swap (ac-1), the renderer path (ac-4), and the
// greeting personalisation (ac-5).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildWelcomeEmail,
  EMAIL_EXPLAINER_VIDEO_URL,
  EMAIL_VIDEO_THUMB_1X_URL,
  EMAIL_VIDEO_THUMB_2X_URL,
  EMAIL_VIDEO_TITLE,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-488/acs/ac-${n}`;

describe("buildWelcomeEmail (v2)", () => {
  const msg = buildWelcomeEmail({
    to: "new@example.com",
    appUrl: "https://int.memex.ai",
    firstName: "Sam",
  });
  const html = msg.html ?? "";
  const text = msg.text ?? "";

  it("uses the v2 subject and CTA, and drops the Option-3 headline", () => {
    tagAc(AC(1));
    expect(msg.subject).toBe(
      "Agents that build it right first time, and every spec speeds up the next",
    );
    expect(html).not.toContain("Build what you decided. Not what your agent guessed.");
    expect(html).toContain("frontier teams build on Memex");
    expect(html).toContain("Open Memex AI");
    expect(html).toContain('href="https://int.memex.ai"');
    expect(msg.commsType).toBe("welcome");
  });

  it("renders the v2 pitch body: the two-point fixes-both list and the To-start bullets", () => {
    tagAc(AC(1));
    expect(html).toContain("Memex fixes both");
    expect(html).toContain("Your docs become living specs");
    expect(html).toContain("Each spec then speeds up the next");
    expect(html).toContain("To start");
    expect(html).toContain("Connect your agent over MCP");
    expect(html).toContain("Create your first spec");
  });

  it("drops the Option-3 resources block, the '// Step N' blocks, and the 'few short emails' line", () => {
    tagAc(AC(1));
    expect(html).not.toContain("Understanding Memex AI");
    expect(html).not.toContain("// Step 1");
    // apostrophe is HTML-escaped in the body, so match an apostrophe-free substring
    expect(html).not.toContain("send you a few short emails");
  });

  it("leads with the greeting — no repeated H1 headline (ac-4)", () => {
    tagAc(AC(4));
    expect(html).not.toContain("<h1");
    // the "Memex AI" wordmark div is separate from the h1 and still renders
    expect(html).toContain(">Memex AI</div>");
  });

  it("personalises the greeting and degrades to a nameless greeting (ac-5)", () => {
    tagAc(AC(5));
    expect(html).toContain("Hi Sam,");
    const nameless = buildWelcomeEmail({ to: "x@y.com", appUrl: "https://int.memex.ai" }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("Hi ,");
  });

  it("renders through the shared renderer under Postmark constraints (doctype, table, solid CTA) (ac-4)", () => {
    tagAc(AC(4));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('role="presentation"');
    expect(html).toContain("background:#0482DC;color:#FFFFFF");
    expect(html).not.toContain("linear-gradient");
    // two-line sign-off carried over from spec-451
    expect(html).toContain("Best,<br>The Memex AI team");
  });

  it("carries the v2 copy in the plain-text body too, not the old Option-3 copy (ac-1)", () => {
    tagAc(AC(1));
    expect(text).toContain("frontier teams build on Memex");
    expect(text).toContain("Create your first spec");
    expect(text).not.toContain("Build what you decided");
    expect(text).not.toContain("Understanding Memex AI");
  });
});

describe("buildWelcomeEmail (v2) — clickable video thumbnail (spec-488 t-2)", () => {
  const msg = buildWelcomeEmail({
    to: "new@example.com",
    appUrl: "https://int.memex.ai",
    firstName: "Sam",
  });
  const html = msg.html ?? "";
  const text = msg.text ?? "";

  it("contains a clickable thumbnail that opens the hosted explainer video (ac-2)", () => {
    tagAc(AC(2));
    // walkthrough intro line ("Here's" is HTML-escaped → match apostrophe-free)
    expect(html).toContain("short animated walkthrough");
    // an <a> to the hosted mp4 wraps an <img> thumbnail
    expect(html).toMatch(
      /<a href="[^"]*email-explainer-60s\.mp4\?[^"]*utm_campaign=welcome[^"]*"[^>]*>\s*<img/,
    );
    // welcome-specific click attribution (spec-480 dec-6)
    expect(html).toContain("utm_campaign=welcome");
    expect(msg.trackLinks).toBe(true);
  });

  it("reuses spec-480's shared hosted-video + thumbnail assets, not a welcome-only fork (ac-7)", () => {
    tagAc(AC(7));
    // the shared `email-*` objects spec-480 established — a fork would use other URLs
    expect(html).toContain(EMAIL_EXPLAINER_VIDEO_URL);
    expect(html).toContain(`src="${EMAIL_VIDEO_THUMB_1X_URL}"`);
    expect(html).toContain(`srcset="${EMAIL_VIDEO_THUMB_2X_URL} 2x"`);
  });

  it("degrades gracefully when images are blocked — alt text + a visible text link (ac-3)", () => {
    tagAc(AC(3));
    // the thumbnail img carries alt text (never a blank image)
    expect(html).toContain(`alt="Watch: ${EMAIL_VIDEO_TITLE}"`);
    // the image-blocked fallback: a visible text line linking the same video
    expect(html).toContain("Can't see the video above?");
    expect(html).toContain(">Watch it here</a>");
    // the plain-text body always carries the video URL, so it is never unreachable
    expect(text).toContain(EMAIL_EXPLAINER_VIDEO_URL);
    expect(text).toContain("utm_campaign=welcome");
  });
});
