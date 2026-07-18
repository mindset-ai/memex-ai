// spec-465 — email design polish. The accent-COLOUR assertions moved to spec-468
// (coral #FC4F64 → brand blue #0482DC); this file retains spec-465's still-valid,
// colour-independent claims: the "Memex AI" wordmark (ac-3) and the greeting
// fallback (ac-6). spec-465's coral colour ACs (ac-1/ac-2/ac-4/ac-5) are superseded
// by spec-468 and intentionally no longer tagged here.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildWelcomeEmail } from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-465/acs/ac-${n}`;
const INK = "#0E1128";

const welcome = buildWelcomeEmail({ to: "a@b.test", appUrl: "https://int.memex.ai", firstName: "Ada" });

describe("spec-465 — the wordmark reads \"Memex AI\", uniform weight (ac-3)", () => {
  it("renders a single-colour dark-ink \"Memex AI\" wordmark — no dot, no lighter span", () => {
    tagAc(AC(3));
    const html = welcome.html ?? "";
    expect(html).toContain(`color:${INK};">Memex AI</div>`);
    expect(html).not.toContain(">.AI</span>");
    expect(html).not.toContain("font-weight:500");
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
