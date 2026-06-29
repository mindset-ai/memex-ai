// spec-226 t-5 — the dev email-preview surface.
import { describe, it, expect } from "vitest";
import { devToolsRouter } from "./__dev__.js";
import {
  EMAIL_PREVIEW_SAMPLES,
  EMAIL_TEMPLATE_NAMES,
} from "../services/email/preview-samples.js";

describe("email preview samples registry", () => {
  it("builds every registered template without throwing", () => {
    expect(EMAIL_TEMPLATE_NAMES.length).toBeGreaterThan(0);
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const msg = EMAIL_PREVIEW_SAMPLES[name]("preview@example.com");
      expect(msg.to).toBe("preview@example.com");
      expect(msg.subject).toBeTruthy();
      expect(msg.html, `${name} should render html`).toContain("<html");
    }
  });
});

describe("GET /email-preview", () => {
  it("renders a known template as HTML", async () => {
    const res = await devToolsRouter.request("/email-preview?template=verification");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("Confirm your email");
  });

  it("lists templates when no template is given", async () => {
    const res = await devToolsRouter.request("/email-preview");
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(body).toContain(`template=${name}`);
    }
  });

  it("404s an unknown template (and echoes the valid names)", async () => {
    const res = await devToolsRouter.request("/email-preview?template=does-not-exist");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { templates: string[] };
    expect(json.templates).toEqual(EMAIL_TEMPLATE_NAMES);
  });
});
