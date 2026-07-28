// spec-515 t-6 / ac-9 — a flat `/api/<root>` mount cannot exist without its
// tenant-parsing exemption.
//
// dec-7 chose option A: one helper registers the routers AND ties the root to the
// exemption, so the two cannot disagree. This file pins the three claims that make
// that true, plus a static scan proving no raw `app.route("/api/<root>", …)`
// survives to bypass the helper.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { mountFlatApi } from "./flat-api-mounts.js";
import { FLAT_API_MOUNT_ROOTS } from "./api-roots.js";
import { parseMemexPath, reservedApiRoots } from "../middleware/memex-resolver.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-9";

const APP_SRC = readFileSync(
  fileURLToPath(new URL("../app.ts", import.meta.url)),
  "utf8",
);

describe("mountFlatApi (spec-515 t-6 / ac-9)", () => {
  it("refuses to mount a root that is not declared — at boot, not at 404 time", () => {
    // THE guarantee. Today's failure mode is a route that mounts fine and then
    // 404s in production for six months. After this, the same mistake refuses to
    // start the server: loud, immediate, impossible to deploy past.
    tagAc(AC);
    const app = new Hono();
    expect(() => mountFlatApi(app, "not-a-declared-root", new Hono())).toThrow(
      /not-a-declared-root/,
    );
  });

  it("mounts every router it is given, in the order given", () => {
    tagAc(AC);
    const app = new Hono();
    const first = new Hono().get("/only-on-first", (c) => c.text("first"));
    const second = new Hono().get("/only-on-second", (c) => c.text("second"));
    // `docs` is a real declared root that carries two routers in app.ts — the
    // shape a flat list could not express (dec-7).
    mountFlatApi(app, "docs", first, second);
    expect(app.routes.some((r) => r.path === "/api/docs/only-on-first")).toBe(true);
    expect(app.routes.some((r) => r.path === "/api/docs/only-on-second")).toBe(true);
  });

  it("exempts every declared flat root from tenant parsing", () => {
    tagAc(AC);
    const swallowed = [...FLAT_API_MOUNT_ROOTS].filter(
      (root) => parseMemexPath(`/api/${root}/anything`) !== null,
    );
    expect(swallowed).toEqual([]);
  });

  it("the effective exempt set is the declared roots plus the non-flat ones", () => {
    tagAc(AC);
    const effective = reservedApiRoots();
    for (const root of FLAT_API_MOUNT_ROOTS) expect(effective).toContain(root);
    // Non-flat shapes that still need exemption: a deep mount and a direct handler.
    expect(effective).toContain("stripe"); // /api/stripe/webhook
    expect(effective).toContain("health"); // app.get("/api/health")
  });

  it("no raw app.route(\"/api/<root>\") bypasses the helper in app.ts", () => {
    // The escape hatch dec-7 accepted: the helper is by-construction only for
    // callers that use it. This scan is what closes it. Tenant-prefixed mounts
    // (`/api/:namespace/...`), deep mounts (`/api/stripe/webhook`) and the
    // catch-all (`/api/*`) are all out of scope — only a flat single-segment root.
    tagAc(AC);
    const raw = [
      ...APP_SRC.matchAll(/app\.route\(\s*"\/api\/([a-z0-9-]+)"\s*,/g),
    ].map((m) => m[1]);
    expect(raw).toEqual([]);
  });

  it("still resolves a genuine tenant path", () => {
    tagAc(AC);
    expect(parseMemexPath("/api/mindset-prod/memex-building-itself/docs")).toEqual({
      namespaceSlug: "mindset-prod",
      memexSlug: "memex-building-itself",
    });
  });
});
