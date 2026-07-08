// spec-453 — copy/render guards for the two new activation emails (Slice A).
// PURE-RENDER assertions on both the plain-text and HTML bodies (both are sent).
// The behavioural claims (dedup, suppression, Day-12 gating, emission-key
// attribution) are exercised at the send/trigger sites in t-2 / t-5, not here.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildVerifiedMilestoneEmail, buildConnectPeopleEmail } from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

describe('spec-453 "See it verified" copy', () => {
  const appUrl = "https://int.memex.ai/acme/personal/specs";
  const email = buildVerifiedMilestoneEmail({ to: "x@y.com", firstName: "Ada", appUrl });

  it("renders the signed-off subject, preheader and core copy (text + html) [ac-5][ac-13]", () => {
    tagAc(AC(5));
    tagAc(AC(13));
    expect(email.subject).toBe("Green means it's actually done");
    // preheader lives in the HTML only
    expect(email.html).toContain("Every acceptance criterion, checked in CI, before anyone calls it finished.");
    for (const body of [email.text ?? "", email.html ?? ""]) {
      expect(body).toContain("Now you can prove it");
      expect(body).toContain("verified, not assumed");
      expect(body).toContain("spec, decision, build, proof");
    }
  });

  it("CTA is the generic Specs board (no deep-link), rendered with no imagery [ac-13][ac-5]", () => {
    tagAc(AC(13));
    tagAc(AC(5));
    // "Go to Memex AI" → exactly the appUrl passed in; no per-send deep-link to a spec/AC.
    expect(email.html).toContain(">Go to Memex AI</a>");
    expect(email.html).toContain(`href="${appUrl}"`);
    expect(email.html).not.toContain("?new=");
    // Postmark constraints: table-based, inline styles, NO imagery.
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain('role="presentation"');
    // Generic/evergreen: only the greeting is personalised; no spec-name / AC-count injection.
    const other = buildVerifiedMilestoneEmail({ to: "x@y.com", firstName: "Grace", appUrl });
    expect((email.html ?? "").replace("Ada", "Grace")).toBe(other.html);
    // stable dedup key stamped (behavioural dedup is verified in t-2).
    expect(email.commsType).toBe("activation.verified_milestone");
  });
});

describe('spec-453 "Connect with people" copy', () => {
  const email = buildConnectPeopleEmail({ to: "x@y.com", firstName: "Ada" });

  it("renders the signed-off subject, preheader and core copy (text + html) [ac-15]", () => {
    tagAc(AC(15));
    expect(email.subject).toBe("You've run the loop. Don't run it alone.");
    // preheader is escapeHtml'd in the HTML — the apostrophe becomes &#39;.
    expect(email.html).toContain("Real people, whenever you&#39;re stuck.");
    for (const body of [email.text ?? "", email.html ?? ""]) {
      expect(body).toContain("last of your onboarding emails");
      expect(body).toContain("Discord is the easiest way in");
    }
  });

  it("CTA links to the confirmed Discord invite, not the retired placeholder [ac-8][ac-15]", () => {
    tagAc(AC(8));
    tagAc(AC(15));
    expect(email.html).toContain(">Join the Discord</a>");
    for (const body of [email.text ?? "", email.html ?? ""]) {
      expect(body).toContain("https://discord.com/invite/WJfBYG9eV");
      // the retired spec-428 placeholder must not survive anywhere in this email.
      expect(body).not.toContain("www.memex.ai/discord");
    }
    expect(email.commsType).toBe("activation.connect_people");
  });
});
