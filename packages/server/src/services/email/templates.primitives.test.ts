// spec-226 t-3 / ac-3 / ac-5 — the step + resources layout primitives (dec-2):
// additive, table/inline-CSS constructs, and back-compatible (the existing 6
// emails render unchanged when the new fields are absent).
import { describe, it, expect } from "vitest";
import {
  renderSteps,
  renderResources,
  buildVerificationEmail,
  type EmailStep,
  type EmailResource,
} from "./templates.js";

describe("renderSteps", () => {
  it("returns empty string for no steps", () => {
    expect(renderSteps()).toBe("");
    expect(renderSteps([])).toBe("");
  });

  it("renders label, title and body for each step, no imagery", () => {
    const steps: EmailStep[] = [
      { label: "// Step 1", title: "Connect to the Memex MCP", body: "The app shows you how." },
      { label: "// Step 2", title: "Create your first Spec", body: "Bring an idea." },
    ];
    const html = renderSteps(steps);
    expect(html).toContain("// Step 1");
    expect(html).toContain("Connect to the Memex MCP");
    expect(html).toContain("The app shows you how.");
    expect(html).toContain("// Step 2");
    expect(html).not.toContain("<img");
  });

  it("escapes dynamic content", () => {
    const html = renderSteps([{ label: "x", title: "<script>", body: "b" }]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("renderResources", () => {
  it("returns empty string for no resources", () => {
    expect(renderResources()).toBe("");
    expect(renderResources([])).toBe("");
  });

  it("renders a table of title-link + description rows, not image buttons", () => {
    const resources: EmailResource[] = [
      { title: "Documentation", description: "The complete reference.", url: "https://memex.ai/docs" },
    ];
    const html = renderResources(resources);
    expect(html).toContain("<table");
    expect(html).toContain('href="https://memex.ai/docs"');
    expect(html).toContain("Documentation");
    expect(html).toContain("The complete reference.");
    expect(html).not.toContain("<img");
  });
});

describe("back-compatibility (existing emails set neither field)", () => {
  const html = buildVerificationEmail({
    to: "x@y.com",
    verifyUrl: "https://int.memex.ai/verify-email?token=T",
  }).html ?? "";

  it("renders no step or resources markup", () => {
    expect(html).not.toContain("// Step");
    // no resources table injected (the layout has no <table> rows of that shape)
    expect(html).not.toContain('border-top:1px solid #E5E7EB;">' + "<a");
  });

  it("still shows the paste-link line (showPasteLink defaults to true)", () => {
    expect(html).toContain("Or paste this link into your browser");
  });
});
