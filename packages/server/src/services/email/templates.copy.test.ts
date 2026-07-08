// spec-226 t-2 / ac-2 — the two auth-first emails (verification + magic-link)
// read warmer and say who-it's-from / why, replacing the dismissive context-light
// tone ("someone probably mistyped their email", "nothing will change").
// Asserted on BOTH the plain-text and HTML bodies, since both are sent.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildVerificationEmail, buildMagicLinkEmail } from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-226/acs/ac-${n}`;

describe("auth-email copy is warm and contextual (ac-2)", () => {
  const verify = buildVerificationEmail({
    to: "x@y.com",
    verifyUrl: "https://int.memex.ai/verify-email?token=T",
  });
  const magic = buildMagicLinkEmail({
    to: "x@y.com",
    loginUrl: "https://int.memex.ai/auth/magic?token=T",
  });

  it("verification email drops the dismissive tone and says who/why (text + html)", () => {
    tagAc(AC(2));
    for (const body of [verify.text ?? "", verify.html ?? ""]) {
      expect(body).not.toContain("nothing will change");
      // who it's from / why you got it
      expect(body).toContain("sign up for Memex");
    }
  });

  it("magic-link email no longer blames a 'mistyped' email and explains who/why (text + html)", () => {
    tagAc(AC(2));
    for (const body of [magic.text ?? "", magic.html ?? ""]) {
      expect(body).not.toContain("mistyped");
      // who it's from / why you got it
      expect(body).toContain("sign-in link for Memex");
    }
  });
});
