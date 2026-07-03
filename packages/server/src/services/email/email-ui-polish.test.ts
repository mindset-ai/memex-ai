// spec-451 — email UI polish. Asserts the rendered HTML/text of the shared renderer +
// per-template output: no eyebrow anywhere, single-colour dark wordmark, wordmark→
// headline spacing, restyled coral step labels (keeping "// Step N"), and the two-line
// sign-off. All emails render through the one shared renderEmailHtml()/renderSteps().
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  renderSteps,
  buildDomainVerificationEmail,
  buildVerificationEmail,
  buildMagicLinkEmail,
  buildWaitlistConfirmationEmail,
  buildMcpCanonicalRefsSwitchEmail,
  buildPasswordResetEmail,
  buildMentionEmail,
  buildAssignmentEmail,
  buildWelcomeEmail,
  buildConnectedInactiveEmail,
  buildSignedInDormantEmail,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-451/acs/ac-${n}`;

// Brand colours (mirror templates.ts).
const CORAL = "#FC4F64";
const INK = "#0E1128";
const SKY = "#0C9FE3";
const MONO_MARKER = "'SF Mono'"; // MONO_STACK signature
const EYEBROW_MARKER = "letter-spacing:0.14em"; // the old eyebrow div's unique style

// Every email that previously rendered an eyebrow (dec-1: all lose it).
const eyebrowed: Array<[string, { html?: string }]> = [
  ["domain", buildDomainVerificationEmail({ to: "a@b.test", orgName: "Acme", domain: "acme.test", verifyUrl: "https://x/y" })],
  ["verification", buildVerificationEmail({ to: "a@b.test", verifyUrl: "https://x/y" })],
  ["magic", buildMagicLinkEmail({ to: "a@b.test", loginUrl: "https://x/y" })],
  ["waitlist", buildWaitlistConfirmationEmail({ to: "a@b.test", name: "Ada" })],
  ["mcp", buildMcpCanonicalRefsSwitchEmail({ to: "a@b.test", tokensUrl: "https://x/y" })],
  ["password", buildPasswordResetEmail({ to: "a@b.test", resetUrl: "https://x/y" })],
  ["mention", buildMentionEmail({ to: "a@b.test", mentionerName: "Ada", specLabel: "spec-1", commentUrl: "https://x/y" })],
  ["assignment", buildAssignmentEmail({ to: "a@b.test", assignerName: "Ada", specLabel: "spec-1", commentUrl: "https://x/y" })],
];

const welcome = buildWelcomeEmail({ to: "a@b.test", appUrl: "https://memex.ai", firstName: "Ada" });
const connected = buildConnectedInactiveEmail({ to: "a@b.test", firstName: "Ada", createSpecUrl: "https://memex.ai/n/m/specs?new=1", memexUrl: "https://memex.ai/n/m/specs" });
const signedIn = buildSignedInDormantEmail({ to: "a@b.test", firstName: "Ada", appUrl: "https://memex.ai" });
const activation: Array<[string, { html?: string; text: string }]> = [
  ["welcome", welcome],
  ["connected", connected],
  ["signedInDormant", signedIn],
];

describe("spec-451 — eyebrow removed everywhere (ac-1, ac-6)", () => {
  for (const [name, msg] of eyebrowed) {
    it(`${name}: no eyebrow — headline is first under the wordmark`, () => {
      tagAc(AC(1));
      tagAc(AC(6));
      const html = msg.html!;
      // No eyebrow div (its unique letter-spacing signature is gone).
      expect(html).not.toContain(EYEBROW_MARKER);
      // The wordmark is immediately followed by the <h1> — nothing between them.
      expect(html).toMatch(/\.AI<\/span><\/div>\s*<h1/);
    });
  }
  it("the activation/welcome emails also carry no eyebrow", () => {
    tagAc(AC(6));
    for (const [, msg] of activation) {
      expect(msg.html!).not.toContain(EYEBROW_MARKER);
      expect(msg.html!).toMatch(/\.AI<\/span><\/div>\s*<h1/);
    }
  });
});

describe("spec-451 — single-colour dark wordmark (ac-2)", () => {
  it("the .AI wordmark renders in dark ink, not coral, as live text (no img/svg)", () => {
    tagAc(AC(2));
    for (const [, msg] of [...eyebrowed, ...activation]) {
      const html = msg.html!;
      expect(html).toContain(`color:${INK};">.AI</span>`);
      expect(html).not.toContain(`color:${CORAL};">.AI</span>`);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<svg");
    }
  });
});

describe("spec-451 — spacing between wordmark and headline (ac-3, ac-8)", () => {
  it("the wordmark carries a non-zero bottom margin above the headline", () => {
    tagAc(AC(3));
    tagAc(AC(8));
    // wordmark div now leads with a margin; capture the bottom value and assert > 0.
    const m = welcome.html!.match(/<div style="margin:0 0 (\d+)px;font-size:20px;font-weight:700/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});

describe("spec-451 — step labels restyled, '// Step N' kept (ac-4, ac-7, ac-8)", () => {
  const stepsHtml = renderSteps([{ label: "// Step 1", title: "Connect", body: "Body." }]);
  it("label is body-font, bold, coral — not blue mono — and keeps the '// ' prefix", () => {
    tagAc(AC(4));
    tagAc(AC(7));
    // The "// Step 1" text is retained.
    expect(stepsHtml).toContain("// Step 1");
    // Restyled: coral + bold, no longer blue mono / eyebrow letter-spacing.
    expect(stepsHtml).toContain(`color:${CORAL}`);
    expect(stepsHtml).toContain("font-weight:700");
    expect(stepsHtml).not.toContain(SKY);
    expect(stepsHtml).not.toContain(MONO_MARKER);
    expect(stepsHtml).not.toContain("letter-spacing:0.08em");
  });
  it("a non-zero gap separates the label from the title beneath it (ac-8)", () => {
    tagAc(AC(8));
    const m = stepsHtml.match(/<div style="margin:(\d+)px 0 2px;font-size:16px;font-weight:600/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});

describe("spec-451 — two-line sign-off (ac-5)", () => {
  for (const [name, msg] of activation) {
    it(`${name}: "Best," and "The Memex AI team" on two lines (HTML + text)`, () => {
      tagAc(AC(5));
      expect(msg.html!).toContain("Best,<br>The Memex AI team");
      expect(msg.text).toContain("Best,\nThe Memex AI team");
    });
  }
});
