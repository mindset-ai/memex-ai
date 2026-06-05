import { describe, it, expect, afterEach } from "vitest";
import { buildAppBaseUrl, buildTenantUrl } from "./tenant-url.js";

describe("buildAppBaseUrl", () => {
  const original = process.env.APP_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = original;
  });

  it("defaults to localhost:5173 when APP_BASE_URL is unset (dev)", () => {
    delete process.env.APP_BASE_URL;
    expect(buildAppBaseUrl()).toBe("http://localhost:5173");
  });

  it("returns int host", () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    expect(buildAppBaseUrl()).toBe("https://int.memex.ai");
  });

  it("returns prod host", () => {
    process.env.APP_BASE_URL = "https://memex.ai";
    expect(buildAppBaseUrl()).toBe("https://memex.ai");
  });

  it("strips trailing path from APP_BASE_URL", () => {
    process.env.APP_BASE_URL = "https://int.memex.ai/admin";
    expect(buildAppBaseUrl()).toBe("https://int.memex.ai");
  });
});

describe("buildTenantUrl", () => {
  const original = process.env.APP_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = original;
  });

  it("composes path-based tenant URL on int", () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    expect(buildTenantUrl({ namespace: "mindset-int", memex: "memex-app" })).toBe(
      "https://int.memex.ai/mindset-int/memex-app",
    );
  });

  it("composes path-based tenant URL on prod", () => {
    process.env.APP_BASE_URL = "https://memex.ai";
    expect(buildTenantUrl({ namespace: "acme", memex: "main" })).toBe(
      "https://memex.ai/acme/main",
    );
  });

  it("composes path-based tenant URL in dev", () => {
    delete process.env.APP_BASE_URL;
    expect(buildTenantUrl({ namespace: "mindset", memex: "playground" })).toBe(
      "http://localhost:5173/mindset/playground",
    );
  });

  it("never subdomain-prefixes the host", () => {
    process.env.APP_BASE_URL = "https://int.memex.ai";
    const url = buildTenantUrl({ namespace: "mindset-int", memex: "memex-app" });
    expect(url).not.toMatch(/\bmindset-int\.int\.memex\.ai\b/);
  });
});
