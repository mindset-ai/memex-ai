// spec-226 t-5 / t-6 / t-7 — the email-preview surface (render + mount gate + auth + send).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { devToolsRouter, shouldMountDevTools } from "./__dev__.js";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { setEmailSender, type EmailSender, type EmailMessage } from "../services/email/sender.js";
import type { User } from "../db/schema.js";
import {
  EMAIL_PREVIEW_SAMPLES,
  EMAIL_TEMPLATE_NAMES,
} from "../services/email/preview-samples.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-226/acs/ac-${n}`;

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
    tagAc(AC(6)); // the gallery iframe shows exactly this rendered HTML
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

// spec-226 t-6 (dec-3) — reachable on int + local/e2e, never prod.
describe("dev-tools mount gate (shouldMountDevTools)", () => {
  it("mounts on local, int and test, but NEVER prod", () => {
    tagAc(AC(6)); // neither the page nor the API route is reachable on prod
    expect(shouldMountDevTools("prod")).toBe(false);
    expect(shouldMountDevTools("int")).toBe(true);
    expect(shouldMountDevTools("local")).toBe(true);
    expect(shouldMountDevTools("test")).toBe(true);
  });
});

// spec-226 t-6 (dec-3) — behind sessionMiddleware: a bare (cookie-less, token-less)
// browser hit must 401, since auth is Bearer/localStorage. The SPA gallery supplies
// the token via the http client; this proves the unauthenticated path is rejected.
describe("email-preview requires authentication when mounted", () => {
  const app = new Hono();
  app.use("/api/__dev__/*", sessionMiddleware);
  app.route("/api/__dev__", devToolsRouter);

  it("401s an unauthenticated request (no Authorization header)", async () => {
    tagAc(AC(6)); // the preview API requires authentication
    const res = await app.request("/api/__dev__/email-preview?template=verification");
    expect(res.status).toBe(401);
  });
});

// spec-226 t-7 (dec-4) — the send-test endpoint sends ONLY to the session user's
// own email; the body-supplied recipient is ignored (no open relay).
describe("POST /email-preview/send (own-email only)", () => {
  let sent: EmailMessage[] = [];
  const fakeSender: EmailSender = {
    send: async (m: EmailMessage) => {
      sent.push(m);
    },
  };

  beforeEach(() => {
    sent = [];
    setEmailSender(fakeSender);
  });
  afterEach(() => {
    setEmailSender(null);
  });

  // A stub auth middleware injects an authenticated user so we exercise the route's
  // OWN recipient logic; the real 401 gate is covered in the next block.
  const authedApp = new Hono<SessionEnv>();
  authedApp.use("/api/__dev__/*", async (c, next) => {
    c.set("user", { email: "me@example.com" } as unknown as User);
    await next();
  });
  authedApp.route("/api/__dev__", devToolsRouter);

  it("sends to the session email, IGNORING any body-supplied recipient (ac-7)", async () => {
    tagAc(AC(7));
    const res = await authedApp.request("/api/__dev__/email-preview/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "verification", to: "attacker@evil.com" }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("me@example.com");
    expect(sent[0].to).not.toBe("attacker@evil.com");
  });

  it("404s an unknown template and sends nothing (ac-7)", async () => {
    tagAc(AC(7));
    const res = await authedApp.request("/api/__dev__/email-preview/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});

describe("POST /email-preview/send requires authentication", () => {
  const app = new Hono();
  app.use("/api/__dev__/*", sessionMiddleware);
  app.route("/api/__dev__", devToolsRouter);

  it("401s an unauthenticated send (ac-7)", async () => {
    tagAc(AC(7));
    const res = await app.request("/api/__dev__/email-preview/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "verification" }),
    });
    expect(res.status).toBe(401);
  });
});
