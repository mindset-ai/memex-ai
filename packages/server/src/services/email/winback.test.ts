// spec-480 t-2 + spec-487 t-3 — the single-segment win-back email builder. PURE RENDER.
// spec-480 owns the clickable-thumbnail MECHANISM + the signed_in_dormant send-path
// keying (still holds); spec-487 swapped the VIDEO (explainer → the "connect the MCP +
// create a spec" how-to) and the COPY (s-3), coordinated with spec-480 (dec-5).
//   spec-480 ac-8/9/10/15/2/3/11/14 — the thumbnail mechanism + send-path keying
//   spec-487 ac-10 — the s-3 copy · ac-8 — one poster + fallback, no Watch button
//   spec-487 ac-9  — send path unchanged (commsType, CTA) · ac-7 — hosted how-to mp4
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildWinbackEmail, EMAIL_HOWTO_CONNECT_MCP } from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-480/acs/ac-${n}`;
const AC487 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-487/acs/ac-${n}`;

const CONNECT_URL = "https://www.memex.ai/download?src=winback-email";

const msg = buildWinbackEmail({ to: "user@example.com", firstName: "Ada", connectUrl: CONNECT_URL });
const html = msg.html ?? "";
const text = msg.text ?? "";

// The video href the template emits: the how-to asset (spec-487) + this email's UTM.
const videoHref = `${EMAIL_HOWTO_CONNECT_MCP.videoUrl}?utm_source=lifecycle&utm_medium=email&utm_campaign=winback`;
// In HTML attributes the ampersands are escaped to &amp; (plain-text keeps the raw URL).
const videoHrefHtml = videoHref.replace(/&/g, "&amp;");

describe("buildWinbackEmail — the clickable video thumbnail (spec-480 mechanism, spec-487 ac-8)", () => {
  it("renders exactly ONE image — the how-to thumbnail — no separate Watch button", () => {
    tagAc(AC(1));
    tagAc(AC487(8));
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Watch the 3-min guide");
  });

  it("references the thumbnail via a hosted, table-safe https <img> (ac-8)", () => {
    tagAc(AC(8));
    expect(html).toContain(`src="${EMAIL_HOWTO_CONNECT_MCP.thumb1xUrl}"`);
    expect(html).not.toContain("cid:");
    expect(html).toContain('width="480"');
    expect(html).toContain('height="269"');
    expect(html).toContain("display:block");
    expect(html).toContain("border:0");
  });

  it("serves 480 as the default src and 960 as the 2x srcset candidate (ac-9)", () => {
    tagAc(AC(9));
    expect(html).toContain(`src="${EMAIL_HOWTO_CONNECT_MCP.thumb1xUrl}"`);
    expect(html).toContain(`srcset="${EMAIL_HOWTO_CONNECT_MCP.thumb2xUrl} 2x"`);
  });
});

describe("buildWinbackEmail — alt text, clickable block, image-blocked fallback (ac-10)", () => {
  it("gives the thumbnail meaningful alt text describing the how-to video", () => {
    tagAc(AC(10));
    tagAc(AC487(8));
    expect(html).toContain(`alt="Watch: how to connect the MCP and create a spec"`);
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
    expect(html).toContain(`<a href="${videoHrefHtml}" style="color:#0482DC`);
    expect(text).toContain(videoHref);
  });
});

describe("buildWinbackEmail — s-3 copy, single CTA, send path (spec-487 ac-9/ac-10)", () => {
  it("renders the s-3 copy — subject + a key body line; old s-2 win-back copy gone", () => {
    tagAc(AC487(10));
    expect(msg.subject).toBe("Ground your specs in your actual codebase");
    // key s-3 line (no apostrophes → literal in both html and text)
    expect(html).toContain("Memex never touches your repo, but your coding agent does");
    expect(text).toContain("Memex never touches your repo, but your coding agent does");
    // old s-2 win-back copy is gone
    expect(html).not.toContain("You signed up to Memex, then disappeared");
  });

  it("keeps the send path: exactly one 'Connect your agent' CTA, never 'Create a spec' (ac-14, spec-487 ac-9)", () => {
    tagAc(AC(14));
    tagAc(AC487(9));
    const ctaCount = (html.match(/background:#0482DC;color:#FFFFFF/g) ?? []).length;
    expect(ctaCount).toBe(1);
    expect(html).toContain(">Connect your agent</a>");
    expect(html).not.toContain(">Create a spec</a>");
    // the CTA deep-links the passed connect URL, not a hardcoded host (std-2/dec-8)
    expect(html).toContain(`href="${CONNECT_URL}"`);
    expect(text).toContain(CONNECT_URL);
  });

  it("stamps the stable signed_in_dormant comms key + trackLinks, unchanged (spec-487 ac-9)", () => {
    tagAc(AC487(9));
    expect(msg.commsType).toBe("activation.signed_in_dormant");
    expect(msg.trackLinks).toBe(true);
  });
});

describe("buildWinbackEmail — links the raw how-to mp4 directly, no wrapper (ac-15, spec-487 ac-7)", () => {
  it("the thumbnail + fallback target the raw public how-to mp4, not an app/wrapper route", () => {
    tagAc(AC(15));
    tagAc(AC487(7));
    expect(videoHref).toContain(
      "storage.googleapis.com/memex-ai-prod-app-static/media/email-howto-connect-mcp.mp4",
    );
    expect(html).toContain(`href="${videoHrefHtml}"`);
    expect(videoHref).not.toContain("/specs");
    expect(videoHref).not.toContain("drive.google.com");
  });
});

describe("buildWinbackEmail — click attribution (ac-11)", () => {
  it("enables Postmark click tracking and carries win-back UTM on the video link", () => {
    tagAc(AC(11));
    tagAc(AC(6)); // scope: a thumbnail click is attributable
    expect(msg.trackLinks).toBe(true);
    expect(html).toContain("utm_source=lifecycle");
    expect(html).toContain("utm_campaign=winback");
  });
});

describe("buildWinbackEmail — stable public video asset (spec-480 ac-2/ac-3/ac-7)", () => {
  it("links a raw public GCS bucket mp4 — stable, permanent, no login, not a Drive share", () => {
    tagAc(AC(7));
    tagAc(AC(3));
    tagAc(AC(2));
    const base = EMAIL_HOWTO_CONNECT_MCP.videoUrl;
    expect(base).toContain("storage.googleapis.com/memex-ai-prod-app-static/media/");
    expect(base).toMatch(/\.mp4$/);
    expect(base).not.toContain("drive.google.com");
    expect(base).not.toContain("X-Goog-Signature");
    expect(base).not.toContain("Expires=");
    expect(base).not.toContain("?");
    expect(videoHref).not.toContain("/login");
    expect(videoHref).not.toContain("/auth");
    expect(videoHref).not.toContain("/specs");
  });
});

describe("buildWinbackEmail — greeting personalisation (ac-1)", () => {
  it("interpolates the first name, degrades to 'Hi there,' with no name", () => {
    tagAc(AC(1));
    expect(html).toContain("Hi Ada,");
    const nameless = buildWinbackEmail({ to: "a@b.test", connectUrl: CONNECT_URL }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("[FirstName]");
    expect(nameless).not.toContain("Hi ,");
  });
});
