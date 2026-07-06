// spec-465 — email design polish. Asserts the new shared + per-template treatment:
// coral CTA button (white label), coral resource links everywhere, the "Memex AI"
// wordmark (no dot, uniform weight), the connected-inactive "your Memex" coral link,
// the signed-in-dormant "#help" coral Discord link, and the greeting fallback.
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

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-465/acs/ac-${n}`;

const CORAL = "#FC4F64";
const INK = "#0E1128";
const DISCORD = "https://discord.com/invite/WJfBYG9eV";

// A representative spread: a transactional email + the welcome + all activation emails,
// to prove the SHARED changes cascade and the per-template ones land.
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

// Emails that render the resources block.
const withResources: Array<[string, { html?: string }]> = [
  ["welcome", welcome],
  ["connected-inactive", connected],
  ["signed-in-dormant", signedIn],
];

describe("spec-465 — coral CTA button, white label, on every email (ac-1)", () => {
  for (const [name, msg] of all) {
    it(`${name}: button is coral #FC4F64 with white text, no gradient`, () => {
      tagAc(AC(1));
      const html = msg.html ?? "";
      expect(html).toContain(`background:${CORAL};color:#FFFFFF`);
      expect(html).not.toContain(`background:${INK};color:#FFFFFF`);
      expect(html).not.toContain("linear-gradient");
    });
  }
});

describe("spec-465 — resource-block links are coral everywhere (ac-2)", () => {
  for (const [name, msg] of withResources) {
    it(`${name}: the resources block links render in coral`, () => {
      tagAc(AC(2));
      const html = msg.html ?? "";
      expect(html).toContain(`color:${CORAL};font-size:15px;font-weight:600;text-decoration:none;">Understanding Memex AI</a>`);
    });
  }
});

describe("spec-465 — the wordmark reads \"Memex AI\", uniform weight (ac-3)", () => {
  it("renders a single-colour dark-ink \"Memex AI\" wordmark — no dot, no lighter span", () => {
    tagAc(AC(3));
    const html = welcome.html ?? "";
    // one uniform-weight dark-ink wordmark, live text
    expect(html).toContain(`color:${INK};">Memex AI</div>`);
    // the old dotted / lighter-weight ".AI" span is gone
    expect(html).not.toContain(">.AI</span>");
    expect(html).not.toContain("font-weight:500");
  });
});

describe("spec-465 — connected-inactive \"your Memex\" link is coral (ac-4)", () => {
  it("renders the \"your Memex\" link in coral, not sky blue", () => {
    tagAc(AC(4));
    const html = connected.html ?? "";
    expect(html).toContain(`style="color:${CORAL};">your Memex</a>`);
    expect(html).not.toContain(`style="color:#0C9FE3;">your Memex</a>`);
  });
});

describe("spec-465 — signed-in-dormant \"#help\" is a coral Discord link (ac-5)", () => {
  it("links #help to the Discord invite in coral (HTML), plain text stays prose", () => {
    tagAc(AC(5));
    const html = signedIn.html ?? "";
    const text = signedIn.text ?? "";
    expect(html).toContain(`<a href="${DISCORD}" style="color:${CORAL};text-decoration:none;">#help</a>`);
    // the plain-text body keeps "#help" as prose (no raw anchor leaking in)
    expect(text).toContain("#help on Discord");
    expect(text).not.toContain("<a ");
  });
});

describe("spec-465 — greeting shows the name, else \"Hi there,\" (never a placeholder) (ac-6)", () => {
  it("interpolates the user's first name", () => {
    tagAc(AC(6));
    expect(welcome.html ?? "").toContain("Hi Ada,");
    expect((welcome.html ?? "")).not.toContain("[FirstName]");
  });
  it("degrades to \"Hi there,\" with no name — never \"Hi untitled\" or \"Hi ,\"", () => {
    tagAc(AC(6));
    const nameless = buildWelcomeEmail({ to: "a@b.test", appUrl: "https://int.memex.ai" }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("Hi ,");
    expect(nameless.toLowerCase()).not.toContain("hi untitled");
  });
});
