// spec-480 t-2 — the single-segment win-back email builder. PURE RENDER: no
// cohort/timing/send/env logic (that's t-3). Asserts the clickable video
// thumbnail + fallback + single "Connect your agent" CTA on the rendered output.
//   ac-8  — hosted, table-safe <img> referenced by public https URL (dec-2)
//   ac-9  — 480 default src + 960 srcset 2x, single baked poster image (dec-3)
//   ac-10 — alt "Watch: {title}" + whole thumbnail clickable + visible fallback (dec-4)
//   ac-14 — one segment: fixed stall-line, one "Connect your agent" CTA (dec-9)
//   ac-15 — links the raw mp4 directly (no wrapper page / app route) (dec-5)
//   ac-1  — the block reads as a playable video thumbnail (scope)
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildWinbackEmail,
  EMAIL_EXPLAINER_VIDEO_URL,
  EMAIL_VIDEO_THUMB_1X_URL,
  EMAIL_VIDEO_THUMB_2X_URL,
  EMAIL_VIDEO_TITLE,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-480/acs/ac-${n}`;

const CONNECT_URL = "https://www.memex.ai/download?src=winback-email";

const msg = buildWinbackEmail({
  to: "user@example.com",
  firstName: "Ada",
  connectUrl: CONNECT_URL,
});
const html = msg.html ?? "";
const text = msg.text ?? "";

// The video href the template emits (base asset URL + this email's UTM, dec-6).
const videoHref = `${EMAIL_EXPLAINER_VIDEO_URL}?utm_source=lifecycle&utm_medium=email&utm_campaign=winback`;
// In HTML attributes the ampersands are correctly escaped to &amp; (the plain-text
// body keeps the raw URL).
const videoHrefHtml = videoHref.replace(/&/g, "&amp;");

describe("buildWinbackEmail — the clickable video thumbnail (ac-1/ac-8/ac-9)", () => {
  it("renders exactly ONE image — the thumbnail — the rest stays image-free", () => {
    tagAc(AC(1));
    const imgCount = (html.match(/<img/g) ?? []).length;
    expect(imgCount).toBe(1);
  });

  it("references the thumbnail via a hosted, table-safe https <img> (ac-8)", () => {
    tagAc(AC(8));
    // hosted public URL, not a cid: attachment
    expect(html).toContain(`src="${EMAIL_VIDEO_THUMB_1X_URL}"`);
    expect(html).not.toContain("cid:");
    // bulletproof: explicit dimensions, display:block, border:0 (kills Outlook's link border)
    expect(html).toContain('width="480"');
    expect(html).toContain('height="269"');
    expect(html).toContain("display:block");
    expect(html).toContain("border:0");
  });

  it("serves 480 as the default src and 960 as the 2x srcset candidate (ac-9)", () => {
    tagAc(AC(9));
    expect(html).toContain(`src="${EMAIL_VIDEO_THUMB_1X_URL}"`);
    expect(html).toContain(`srcset="${EMAIL_VIDEO_THUMB_2X_URL} 2x"`);
  });
});

describe("buildWinbackEmail — alt text, clickable block, image-blocked fallback (ac-10)", () => {
  it("gives the thumbnail meaningful alt text of the form 'Watch: {title}'", () => {
    tagAc(AC(10));
    expect(html).toContain(`alt="Watch: ${EMAIL_VIDEO_TITLE}"`);
  });

  it("wraps the whole thumbnail in an anchor to the video (clickable even before load)", () => {
    tagAc(AC(10));
    expect(html).toContain(`<a href="${videoHrefHtml}" style="display:block`);
  });

  it("renders a visible fallback line linking the same video when images are blocked", () => {
    tagAc(AC(10));
    tagAc(AC(4)); // scope: the video is never unreachable when images are blocked
    expect(html).toContain("Can't see the video above?");
    expect(html).toContain(`>Watch it here</a>`);
    // the fallback link targets the same video URL
    expect(html).toContain(`<a href="${videoHrefHtml}" style="color:#0482DC`);
    // plain-text body also carries the video URL so it's reachable there too
    expect(text).toContain(videoHref);
  });
});

describe("buildWinbackEmail — single segment, single CTA (ac-14)", () => {
  it("uses the one fixed stall-line for the signed_in_dormant segment", () => {
    tagAc(AC(14));
    // apostrophe-free substring (html escapes apostrophes)
    expect(html).toContain("never connected your agent or created a spec");
  });

  it("has exactly one CTA button — 'Connect your agent' — never 'Create a spec'", () => {
    tagAc(AC(14));
    // one coral CTA button
    const ctaCount = (html.match(/background:#0482DC;color:#FFFFFF/g) ?? []).length;
    expect(ctaCount).toBe(1);
    expect(html).toContain(">Connect your agent</a>");
    expect(html).not.toContain(">Create a spec</a>");
    // the CTA deep-links the passed connect URL, not a hardcoded host (std-2/dec-8)
    expect(html).toContain(`href="${CONNECT_URL}"`);
    expect(text).toContain(CONNECT_URL);
  });

  it("stamps the single stable comms key (dec-8) and the s-2 subject", () => {
    tagAc(AC(14));
    expect(msg.commsType).toBe("activation.signed_in_dormant");
    expect(msg.subject).toBe("You signed up, then vanished");
  });
});

describe("buildWinbackEmail — links the raw mp4 directly, no wrapper (ac-15)", () => {
  it("the thumbnail + fallback target the raw public mp4, not an app/wrapper route", () => {
    tagAc(AC(15));
    // raw GCS mp4 object (Superhuman-style), no intermediary memex.ai app path
    expect(videoHref).toContain(
      "storage.googleapis.com/memex-ai-prod-app-static/media/email-explainer-60s.mp4",
    );
    expect(html).toContain(`href="${videoHrefHtml}"`);
    // the video link is NOT a tenant/app route
    expect(videoHref).not.toContain("/specs");
  });
});

describe("buildWinbackEmail — click attribution (ac-11)", () => {
  it("enables Postmark click tracking and carries win-back UTM on the video link", () => {
    tagAc(AC(11));
    tagAc(AC(6)); // scope: a thumbnail click is attributable
    // Postmark rewrites the link → a click fires a webhook event (comms_log). The UTM
    // labels the tracked URL as the winback campaign (vs the welcome reuse of the asset).
    expect(msg.trackLinks).toBe(true);
    expect(html).toContain("utm_source=lifecycle");
    expect(html).toContain("utm_campaign=winback");
  });
});

describe("buildWinbackEmail — stable public video asset (ac-2/ac-3/ac-7)", () => {
  it("links a raw public GCS bucket mp4 — stable, permanent, no login, not a Drive share", () => {
    tagAc(AC(7)); // served from the stable public bucket URL, never a Drive link
    tagAc(AC(3)); // stable/permanent: no signed-URL token, no expiry, query-free base
    tagAc(AC(2)); // click target is the public asset (no login/app route) — verified 200 + streamable in t-1
    expect(EMAIL_EXPLAINER_VIDEO_URL).toContain(
      "storage.googleapis.com/memex-ai-prod-app-static/media/",
    );
    expect(EMAIL_EXPLAINER_VIDEO_URL).toMatch(/\.mp4$/);
    expect(EMAIL_EXPLAINER_VIDEO_URL).not.toContain("drive.google.com");
    // permanent: no signed-URL / expiry markers, and the base asset URL is query-free
    // (the per-send UTM is appended downstream, not baked into the stored object URL).
    expect(EMAIL_EXPLAINER_VIDEO_URL).not.toContain("X-Goog-Signature");
    expect(EMAIL_EXPLAINER_VIDEO_URL).not.toContain("Expires=");
    expect(EMAIL_EXPLAINER_VIDEO_URL).not.toContain("?");
    // no login/app gate between the click and the file
    expect(videoHref).not.toContain("/login");
    expect(videoHref).not.toContain("/auth");
    expect(videoHref).not.toContain("/specs");
  });
});

describe("buildWinbackEmail — greeting personalisation (ac-1)", () => {
  it("interpolates the first name, degrades to 'Hi there,' with no name", () => {
    tagAc(AC(1));
    expect(html).toContain("Hey Ada,");
    const nameless =
      buildWinbackEmail({ to: "a@b.test", connectUrl: CONNECT_URL }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("[FirstName]");
    expect(nameless).not.toContain("Hey ,");
  });
});
