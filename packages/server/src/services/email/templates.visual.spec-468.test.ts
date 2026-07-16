// spec-468 — email accent recolour: coral #FC4F64 → brand blue #0482DC.
// Owns every accent-colour assertion: CTA button, "// Step N" labels, resource
// links, connected-inactive "your Memex", signed-in-dormant "#help" — plus a
// no-coral-anywhere guard. (Supersedes spec-465's coral colour ACs + spec-451's
// coral step-label.)
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildVerificationEmail,
  buildWelcomeEmail,
  buildConnectedInactiveEmail,
  buildSignedInDormantEmail,
  buildVerifiedMilestoneEmail,
  buildConnectPeopleEmail,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-468/acs/ac-${n}`;
const ACCENT = "#0482DC";
const CORAL = "#FC4F64";
const DISCORD = "https://discord.com/invite/WJfBYG9eV";

const verification = buildVerificationEmail({ to: "a@b.test", verifyUrl: "https://int.memex.ai/verify-email?token=T" });
const welcome = buildWelcomeEmail({ to: "a@b.test", appUrl: "https://int.memex.ai", firstName: "Ada" });
const connected = buildConnectedInactiveEmail({ to: "a@b.test", firstName: "Ada", createSpecUrl: "https://int.memex.ai/n/m/specs/new", memexUrl: "https://int.memex.ai/n/m" });
const signedIn = buildSignedInDormantEmail({ to: "a@b.test", firstName: "Ada", appUrl: "https://int.memex.ai" });
const verified = buildVerifiedMilestoneEmail({ to: "a@b.test", firstName: "Ada", appUrl: "https://int.memex.ai" });
const connect = buildConnectPeopleEmail({ to: "a@b.test", firstName: "Ada" });

const all: Array<[string, { html?: string }]> = [
  ["verification", verification],
  ["welcome", welcome],
  ["connected-inactive", connected],
  ["signed-in-dormant", signedIn],
  ["verified-milestone", verified],
  ["connect-people", connect],
];
// spec-488: the welcome v2 dropped the "Resources to get started" block, so it
// no longer carries resource-link accents — only the two activation emails do.
const withResources: Array<[string, { html?: string }]> = [
  ["connected-inactive", connected],
  ["signed-in-dormant", signedIn],
];

describe("spec-468 — CTA button is #0482DC with white text (ac-1, ac-3)", () => {
  for (const [name, msg] of all) {
    it(`${name}: button background #0482DC, white label, no gradient`, () => {
      tagAc(AC(1));
      tagAc(AC(3));
      const html = msg.html ?? "";
      expect(html).toContain(`background:${ACCENT};color:#FFFFFF`);
      expect(html).not.toContain(`background:${CORAL}`);
      expect(html).not.toContain("linear-gradient");
    });
  }
});

describe("spec-468 — step labels + resource links are #0482DC (ac-1)", () => {
  it("the \"// Step N\" labels render in #0482DC (signed-in-dormant)", () => {
    tagAc(AC(1));
    // spec-488: the welcome v2 dropped the "// Step N" blocks; only the
    // signed-in-dormant email still carries them.
    expect(signedIn.html ?? "").toContain(`color:${ACCENT};">// Step 1`);
  });
  for (const [name, msg] of withResources) {
    it(`${name}: resource-block links render in #0482DC`, () => {
      tagAc(AC(1));
      expect(msg.html ?? "").toContain(`color:${ACCENT};font-size:15px;font-weight:600;text-decoration:none;">Understanding Memex AI</a>`);
    });
  }
});

describe("spec-468 — per-template accent links are #0482DC (ac-1)", () => {
  it("connected-inactive \"your Memex\" link is #0482DC", () => {
    tagAc(AC(1));
    expect(connected.html ?? "").toContain(`style="color:${ACCENT};">your Memex</a>`);
  });
  it("signed-in-dormant \"#help\" is a #0482DC Discord link", () => {
    tagAc(AC(1));
    expect(signedIn.html ?? "").toContain(`<a href="${DISCORD}" style="color:${ACCENT};text-decoration:none;">#help</a>`);
  });
});

describe("spec-468 — no coral remains anywhere (ac-2)", () => {
  for (const [name, msg] of all) {
    it(`${name}: rendered HTML contains no #FC4F64`, () => {
      tagAc(AC(2));
      expect((msg.html ?? "").toUpperCase()).not.toContain(CORAL);
    });
  }
});

describe("spec-468 — presentation-only, accent aside (ac-4)", () => {
  it("the verification email keeps its structure (doctype, solid button, no imagery) with the new accent", () => {
    tagAc(AC(4));
    const html = verification.html ?? "";
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`background:${ACCENT};color:#FFFFFF`);
    expect(html).not.toContain("linear-gradient");
    expect(html).not.toContain("<img");
  });
});
