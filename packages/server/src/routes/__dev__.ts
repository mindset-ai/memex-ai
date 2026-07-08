// spec-226 t-5 — dev-only email preview surface.
//
// Renders any transactional email's HTML straight to the browser so the visual
// redesign can be eyeballed (and iterated on under `tsx watch`) without sending a
// real email. ConsoleEmailSender only prints the plain-text body, so the HTML was
// not viewable before this.
//
// Mounted ONLY off a real deployment — see the gate in app.ts (isDevMode() ||
// MEMEX_ANTHROPIC_FAKE). It is never reachable on int/prod.

import { Hono } from "hono";
import {
  EMAIL_PREVIEW_SAMPLES,
  EMAIL_TEMPLATE_NAMES,
} from "../services/email/preview-samples.js";
import { getEmailSender } from "../services/email/sender.js";
import type { UsageEnv } from "../services/usage-events.js";
import type { SessionEnv } from "../middleware/session.js";

// Typed with SessionEnv so the send route can read the authenticated user off the
// context (the app mounts sessionMiddleware on /api/__dev__/* — see app.ts).
export const devToolsRouter = new Hono<SessionEnv>();

// spec-226 t-6 (dec-3) — the email-preview surface is reachable on local/e2e AND
// int, but NEVER prod. The single mount gate, extracted so it can be unit-tested
// without constructing the whole app (app.ts evaluates the mount once, at import).
export function shouldMountDevTools(env: UsageEnv): boolean {
  return env !== "prod";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// GET /api/__dev__/email-preview/templates → JSON list of template names.
// The React gallery (spec-226 t-6) consumes this to populate its picker, then
// fetches each template's HTML below. JSON (not the HTML index) because the SPA
// renders the picker itself; both are fetched via the token-carrying http client.
devToolsRouter.get("/email-preview/templates", (c) =>
  c.json({ templates: EMAIL_TEMPLATE_NAMES }),
);

// GET /api/__dev__/email-preview            → index of available templates
// GET /api/__dev__/email-preview?template=X → rendered HTML for template X
devToolsRouter.get("/email-preview", (c) => {
  const name = c.req.query("template");

  if (!name) {
    const links = EMAIL_TEMPLATE_NAMES.map(
      (t) =>
        `<li><a href="/api/__dev__/email-preview?template=${encodeURIComponent(t)}">${t}</a></li>`,
    ).join("");
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Email preview</title>` +
        `<body style="font-family:sans-serif;padding:32px;"><h1>Email templates</h1><ul>${links}</ul></body>`,
    );
  }

  const build = EMAIL_PREVIEW_SAMPLES[name];
  if (!build) {
    return c.json({ error: `unknown template '${name}'`, templates: EMAIL_TEMPLATE_NAMES }, 404);
  }

  const msg = build("preview@example.com");
  if (msg.html) return c.html(msg.html);
  // A text-only template (none today) — show the plain body legibly.
  return c.html(`<pre>${escapeHtml(msg.text)}</pre>`);
});

// POST /api/__dev__/email-preview/send — send the chosen template to the
// AUTHENTICATED user's OWN email, resolved from the session and NEVER from the
// request body (spec-226 dec-4): the body carries the template name only, so this
// internal tool can't be turned into an open relay. Goes through the existing
// chokepoint — Postmark when configured (int delivers to the user's own inbox),
// else ConsoleEmailSender prints locally. One consented recipient ⇒ negligible
// Postmark exposure (spec-427 dec-8). Auth + non-prod gating are enforced by the
// sessionMiddleware + shouldMountDevTools mount in app.ts.
devToolsRouter.post("/email-preview/send", async (c) => {
  const body = await c.req.json<{ template?: string }>().catch(() => ({}) as { template?: string });
  const name = body.template;
  const to = c.get("user")?.email;
  if (!to) return c.json({ error: "no authenticated email on session" }, 401);

  if (!name || !EMAIL_PREVIEW_SAMPLES[name]) {
    return c.json({ error: `unknown template '${name ?? ""}'`, templates: EMAIL_TEMPLATE_NAMES }, 404);
  }

  await getEmailSender().send(EMAIL_PREVIEW_SAMPLES[name](to));
  return c.json({ sent: true, to });
});
