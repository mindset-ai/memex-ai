// spec-226 t-1 / t-4 — the shared renderer's visual treatment (dec-1 option 0).
// Asserted on ALL SIX transactional emails to prove the fix lives in the shared
// renderEmailHtml() and cascades — ac-1 (scope: all six corrected) + ac-4 (impl).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildVerificationEmail,
  buildMagicLinkEmail,
  buildPasswordResetEmail,
  buildDomainVerificationEmail,
  buildWaitlistConfirmationEmail,
  buildMcpCanonicalRefsSwitchEmail,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-226/acs/ac-${n}`;

// The six transactional emails the shared renderer backs (spec-226 s-2 table).
const samples = [
  buildVerificationEmail({ to: "x@y.com", verifyUrl: "https://int.memex.ai/verify-email?token=T" }),
  buildMagicLinkEmail({ to: "x@y.com", loginUrl: "https://int.memex.ai/auth/magic?token=T" }),
  buildPasswordResetEmail({ to: "x@y.com", resetUrl: "https://int.memex.ai/reset-password?token=T" }),
  buildDomainVerificationEmail({
    to: "x@y.com",
    orgName: "Sample Org",
    domain: "example.com",
    verifyUrl: "https://int.memex.ai/verify-domain?token=T",
  }),
  buildWaitlistConfirmationEmail({ to: "x@y.com", name: "Sample", company: "Sample Org" }),
  buildMcpCanonicalRefsSwitchEmail({ to: "x@y.com", tokensUrl: "https://int.memex.ai/settings/tokens" }),
];

describe.each(samples.map((m) => [m.subject, m.html ?? ""] as const))(
  "shared email renderer visual treatment — %s",
  (_subject, html) => {
    it("uses a solid BRAND_INK CTA button, never a gradient", () => {
      tagAc(AC(1)); // scope: all six emails carry the corrected treatment
      tagAc(AC(4)); // impl: renderEmailHtml renders a solid BRAND_INK button
      expect(html).toContain("background:#0E1128;color:#FFFFFF");
      expect(html).not.toContain("linear-gradient");
    });

    it("drops the 4px gradient left bar", () => {
      tagAc(AC(1));
      tagAc(AC(4));
      expect(html).not.toContain('width="4"');
    });

    it("does not uppercase the eyebrow", () => {
      tagAc(AC(1));
      tagAc(AC(4));
      expect(html).not.toContain("text-transform:uppercase");
    });

    it("renders the paste-link URL in BRAND_SKY blue", () => {
      tagAc(AC(1));
      tagAc(AC(4));
      expect(html).toContain("color:#0C9FE3;word-break");
    });

    it("has a single plain memex.ai footer (no em-dash, no duplicated branding)", () => {
      tagAc(AC(1));
      tagAc(AC(4));
      expect(html).not.toContain("— Memex");
      expect(html).toContain('<a href="https://memex.ai"');
    });
  },
);
