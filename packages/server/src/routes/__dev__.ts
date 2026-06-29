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

export const devToolsRouter = new Hono();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
