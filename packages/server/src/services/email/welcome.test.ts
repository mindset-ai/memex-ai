// spec-428 t-2 — the welcome email template (Option 3).
import { describe, it, expect } from "vitest";
import { buildWelcomeEmail } from "./templates.js";

describe("buildWelcomeEmail", () => {
  const msg = buildWelcomeEmail({
    to: "new@example.com",
    appUrl: "https://int.memex.ai",
    firstName: "Sam",
  });
  const html = msg.html ?? "";

  it("uses the Option-3 subject/H1 and the Open Memex AI CTA", () => {
    expect(msg.subject).toBe("Build what you decided. Not what your agent guessed.");
    expect(html).toContain("Build what you decided. Not what your agent guessed.");
    expect(html).toContain("Open Memex AI");
    expect(html).toContain('href="https://int.memex.ai"');
  });

  it("personalises the greeting", () => {
    expect(html).toContain("Hi Sam,");
  });

  it("renders both onboarding steps and all three resources (table, no imagery)", () => {
    expect(html).toContain("// Step 1");
    expect(html).toContain("Connect to the Memex MCP");
    expect(html).toContain("// Step 2");
    expect(html).toContain("Create your first Spec");
    expect(html).toContain("Understanding Memex AI");
    expect(html).toContain("Documentation");
    expect(html).toContain("Community");
    expect(html).not.toContain("<img");
  });

  it("includes the post-CTA prose + sign-off, and suppresses the paste-link", () => {
    // apostrophe is HTML-escaped in the body, so match an apostrophe-free substring
    expect(html).toContain("send you a few short emails");
    expect(html).toContain("Best, The Memex AI team");
    expect(html).not.toContain("Or paste this link");
  });

  it("renders no empty eyebrow block (welcome leads with the H1)", () => {
    // the eyebrow div carries the mono sky-blue style + 0.14em tracking; absent here
    expect(html).not.toContain("letter-spacing:0.14em");
  });

  it("is logged under the stable `welcome` comms key (dec-7)", () => {
    expect(msg.commsType).toBe("welcome");
  });

  it("degrades to a nameless greeting when no first name is given", () => {
    const nameless = buildWelcomeEmail({ to: "x@y.com", appUrl: "https://int.memex.ai" }).html ?? "";
    expect(nameless).toContain("Hi there,");
    expect(nameless).not.toContain("Hi ,");
  });
});
