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

  it("uses the verbatim subject + headline + Create-a-spec CTA, rendered from code", () => {
    tagAc(AC(13)); // copy sourced from the code builder, not an external doc
    expect(msg.subject).toBe("Memex is connected. Here's what to do next.");
    // headline (apostrophe-free substring — html escapes it)
    expect(html).toContain("Your Memex MCP is connected. The hard part is done.");
    expect(text).toContain("Your Memex MCP is connected. The hard part is done.");
    expect(html).toContain("Create a spec");
    // the "moment it clicks" prose (apostrophe-free)
    expect(html).toContain("the decisions it needs you to resolve");
    expect(html).toContain("Memex does not touch your code.");
  });

  it("renders solely through the shared renderer with a solid CTA and no imagery (ac-10)", () => {
    tagAc(AC(10));
    expect(html).toContain("<!doctype html>");
    // shared-renderer brand mark + solid BRAND_INK CTA button (never a gradient)
    expect(html).toContain('<span style="font-weight:500;color:#FC4F64;">.AI</span>');
    expect(html).toContain("background:#0E1128;color:#FFFFFF");
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toContain("<img");
    // resources render as a presentation table (a table construct, not image buttons)
    expect(html).toContain('<table role="presentation" width="100%"');
    expect(html).toContain("Understanding Memex AI");
    expect(html).toContain("Documentation");
    expect(html).toContain("Community");
  });

  it("deep-links the CTA + 'your Memex' from the passed URLs, not a hardcoded host (dec-8)", () => {
    tagAc(AC(10));
    expect(html).toContain('href="https://int.memex.ai/mindset-prod/sample/specs/new"');
    expect(html).toContain('href="https://int.memex.ai/mindset-prod/sample"');
    // no prod host baked in when an int URL was supplied
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
    expect(html).toContain("background:#0E1128;color:#FFFFFF");
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
