// spec-427 t-1 (Slice A) — the two activation/win-back email templates, tagged to
// their render ACs. These are PURE RENDER builders: no cohort/timing/send logic and
// no env reads (From/Reply-To are applied at the send site, identical to the landed
// spec-428 welcome — welcome-send.ts:45-46; see spec-427 t-1 drift note).
//   ac-10 — renders solely through the shared renderEmailHtml() + spec-226
//           step/resources primitives; no parallel/raw-HTML path; CTA + resources
//           are table / inline-CSS constructs with no <img>.
//   ac-13 — the copy is sourced from the templates.ts builder fns (the canonical
//           authoring source); nothing reads copy from an external/runtime source.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildConnectedInactiveEmail,
  buildSignedInDormantEmail,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;

describe("buildConnectedInactiveEmail (Email 1 — connected-but-inactive)", () => {
  const msg = buildConnectedInactiveEmail({
    to: "user@example.com",
    firstName: "Sample",
    createSpecUrl: "https://int.memex.ai/mindset-prod/sample/specs/new",
    memexUrl: "https://int.memex.ai/mindset-prod/sample",
  });
  const html = msg.html ?? "";
  const text = msg.text ?? "";

  const AC487 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-487/acs/ac-${n}`;

  it("uses the v2 subject + s-2 copy + Create-a-spec CTA, rendered from code (spec-487 ac-10)", () => {
    tagAc(AC(13)); // spec-427: copy sourced from the code builder, not an external doc
    tagAc(AC487(10)); // spec-487: the s-2 rewrite
    expect(msg.subject).toBe("Connected, but the output has not changed yet");
    // v2 leads with the greeting — no repeated headline
    expect(html).not.toContain("<h1");
    // key s-2 body lines (apostrophe-free substrings — html escapes apostrophes)
    expect(html).toContain("the change you signed up for does not show until there is a Spec");
    expect(html).toContain("A Memex spec fixes that");
    expect(text).toContain("the change you signed up for does not show until there is a Spec");
    expect(html).toContain("Create a spec");
    // old Option-3 copy gone
    expect(html).not.toContain("The hard part is done");
  });

  it("renders through the shared renderer; the only image is the how-to video poster, no Watch button (ac-10, spec-487 ac-8)", () => {
    tagAc(AC(10));
    tagAc(AC487(8));
    tagAc(AC487(7)); // video links the hosted .mp4, never a Drive link
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('color:#0E1128;">Memex AI</div>');
    expect(html).toContain("background:#0482DC;color:#FFFFFF");
    expect(html).not.toContain("linear-gradient");
    // spec-487: exactly ONE image — the video poster — and NO "Watch the 3-min guide" button
    expect((html.match(/<img/g) ?? []).length).toBe(1);
    expect(html).toContain("email-howto-create-spec-thumb-480.png");
    expect(html).not.toContain("Watch the 3-min guide");
    // ac-7: the thumbnail links the hosted .mp4 on the shared bucket, never a Drive link
    expect(html).toContain("storage.googleapis.com/memex-ai-prod-app-static/media/email-howto-create-spec.mp4");
    expect(html).not.toContain("drive.google.com");
    // image-blocked fallback line present (raw apostrophe — not escaped)
    expect(html).toContain("Can't see the video above?");
    // resources still render as a presentation table
    expect(html).toContain('<table role="presentation" width="100%"');
    expect(html).toContain("Understanding Memex AI");
  });

  it("deep-links the Create-a-spec CTA from the passed URL, not a hardcoded host (dec-8)", () => {
    tagAc(AC(10));
    expect(html).toContain('href="https://int.memex.ai/mindset-prod/sample/specs/new"');
    // v2 dropped the "your Memex" link; the CTA is the only app deep-link
    expect(html).not.toContain('href="https://memex.ai/');
  });

  it("stamps the stable activation.connected_inactive comms key (ac-14/dec-7)", () => {
    tagAc(AC(13));
    expect(msg.commsType).toBe("activation.connected_inactive");
  });

  it("personalises the greeting and degrades to a nameless greeting", () => {
    tagAc(AC(13));
    expect(html).toContain("Hi Sample,");
    const nameless =
      buildConnectedInactiveEmail({
        to: "x@y.com",
        createSpecUrl: "https://int.memex.ai/n/m/specs/new",
        memexUrl: "https://int.memex.ai/n/m",
      }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("Hi ,");
  });
});

describe("buildSignedInDormantEmail (Email 2 — signed-in-but-dormant)", () => {
  const msg = buildSignedInDormantEmail({
    to: "user@example.com",
    firstName: "Sample",
    appUrl: "https://int.memex.ai",
  });
  const html = msg.html ?? "";
  const text = msg.text ?? "";

  it("uses the verbatim subject + Open-Memex-AI CTA + two-step copy, rendered from code", () => {
    tagAc(AC(13)); // copy sourced from the code builder, not an external doc
    expect(msg.subject).toBe("You're two steps from your first Spec");
    expect(html).toContain("Open Memex AI");
    expect(html).toContain('href="https://int.memex.ai"');
    // the "no more vibe coding" value prop (apostrophe-free substrings)
    expect(html).toContain("done means verified, not just claimed");
    expect(html).toContain("No more vibe coding.");
    expect(text).toContain("No more vibe coding.");
  });

  it("renders solely through the shared renderer with the step + resources primitives, no imagery (ac-10)", () => {
    tagAc(AC(10));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("background:#0482DC;color:#FFFFFF");
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toContain("<img");
    // spec-226 step primitive
    expect(html).toContain("// Step 1");
    expect(html).toContain("Connect to the Memex MCP");
    expect(html).toContain("// Step 2");
    expect(html).toContain("Create your first Spec");
    // resources table
    expect(html).toContain('<table role="presentation" width="100%"');
    expect(html).toContain("Understanding Memex AI");
  });

  it("stamps the stable activation.signed_in_dormant comms key (ac-14/dec-7)", () => {
    tagAc(AC(13));
    expect(msg.commsType).toBe("activation.signed_in_dormant");
  });

  it("personalises the greeting and degrades to a nameless greeting", () => {
    tagAc(AC(13));
    expect(html).toContain("Hi Sample,");
    const nameless =
      buildSignedInDormantEmail({ to: "x@y.com", appUrl: "https://int.memex.ai" }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("Hi ,");
  });
});
