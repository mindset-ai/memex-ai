// spec-226 t-1 / ac-1 — the shared renderer's visual treatment (dec-1 option 0).
// Asserted on two distinct builders to prove the fix cascades through the shared
// renderEmailHtml() rather than living in one template.
import { describe, it, expect } from "vitest";
import { buildVerificationEmail, buildMagicLinkEmail } from "./templates.js";

const samples = [
  buildVerificationEmail({ to: "x@y.com", verifyUrl: "https://int.memex.ai/verify-email?token=T" }),
  buildMagicLinkEmail({ to: "x@y.com", loginUrl: "https://int.memex.ai/auth/magic?token=T" }),
];

describe.each(samples.map((m) => [m.subject, m.html ?? ""] as const))(
  "shared email renderer visual treatment — %s",
  (_subject, html) => {
    it("uses a solid BRAND_INK CTA button, never a gradient", () => {
      expect(html).toContain("background:#0E1128;color:#FFFFFF");
      expect(html).not.toContain("linear-gradient");
    });

    it("drops the 4px gradient left bar", () => {
      expect(html).not.toContain('width="4"');
    });

    it("does not uppercase the eyebrow", () => {
      expect(html).not.toContain("text-transform:uppercase");
    });

    it("renders the paste-link URL in BRAND_SKY blue", () => {
      expect(html).toContain("color:#0C9FE3;word-break");
    });

    it("has a single plain memex.ai footer (no em-dash, no duplicated branding)", () => {
      expect(html).not.toContain("— Memex");
      expect(html).toContain('<a href="https://memex.ai"');
    });
  },
);
