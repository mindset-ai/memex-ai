import type { EmailMessage } from "./sender.js";

// ──────────────────────────────────────────────────────────────────────────
// Shared HTML layout
// ──────────────────────────────────────────────────────────────────────────
// White background, Memex.AI brand accents (coral→magenta gradient for the CTA
// and a top bar). Inline CSS only — no <style> blocks, no build step — so it
// renders consistently across Gmail, Apple Mail, Outlook, etc.

const BRAND_INK = "#0E1128";
const BRAND_CORAL = "#FC4F64";
const BRAND_SKY = "#0C9FE3";
const BRAND_MUTED = "#6B7280";
const BRAND_BORDER = "#E5E7EB";
const BRAND_LINK = "#CA1A73";
const CTA_GRADIENT = "linear-gradient(135deg, #CA1A73 0%, #FC4F64 100%)";
const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO_STACK = "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface RenderInput {
  preheader: string;
  eyebrow: string;
  heading: string;
  // Interpreted as HTML — caller must escape any dynamic values it interpolates.
  bodyParagraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
  footerNote: string;
}

// Shared plain-text body: intro paragraph(s), optional URL, closing, signoff.
// All separated by blank lines.
function renderEmailText(input: {
  intro: string[];
  url?: string;
  closing: string;
}): string {
  const parts = [...input.intro];
  if (input.url) parts.push(input.url);
  parts.push(input.closing, "Memex.AI");
  return parts.join("\n\n");
}

function renderEmailHtml(input: RenderInput): string {
  const paragraphs = input.bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:${BRAND_INK};font-size:16px;line-height:1.6;">${p}</p>`,
    )
    .join("");

  const safeUrl = escapeHtml(input.ctaUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F7F7F8;font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(input.preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F7F8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border:1px solid ${BRAND_BORDER};border-radius:12px;overflow:hidden;">
            <tr>
              <td width="4" style="width:4px;background:${CTA_GRADIENT};font-size:0;line-height:0;">&nbsp;</td>
              <td style="padding:32px 40px;">
                <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND_INK};">Memex<span style="font-weight:500;color:${BRAND_CORAL};">.AI</span></div>
                <div style="margin:28px 0 10px;font-family:${MONO_STACK};font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND_SKY};">${escapeHtml(input.eyebrow)}</div>
                <h1 style="margin:0 0 16px;color:${BRAND_INK};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;">${escapeHtml(input.heading)}</h1>
                ${paragraphs}
                <div style="margin:24px 0 8px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:${CTA_GRADIENT};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escapeHtml(input.ctaLabel)}</a>
                </div>
                <p style="margin:16px 0 0;color:${BRAND_MUTED};font-size:13px;line-height:1.5;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:${BRAND_LINK};word-break:break-all;">${safeUrl}</a></p>
                <div style="margin:28px 0 0;padding-top:20px;border-top:1px solid ${BRAND_BORDER};">
                  <p style="margin:0;color:${BRAND_MUTED};font-size:12px;line-height:1.5;">${escapeHtml(input.footerNote)}</p>
                  <p style="margin:8px 0 0;color:${BRAND_MUTED};font-size:12px;line-height:1.5;">— Memex<span style="color:${BRAND_CORAL};">.AI</span> · <a href="https://memex.ai" style="color:${BRAND_MUTED};">memex.ai</a></p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────
// Templates
// ──────────────────────────────────────────────────────────────────────────

export interface DomainVerificationEmailInput {
  to: string;
  orgName: string;
  domain: string;
  verifyUrl: string;
}

// Sent to admin@<domain> and postmaster@<domain> per RFC 2142.
export function buildDomainVerificationEmail(
  input: DomainVerificationEmailInput,
): EmailMessage {
  const text = renderEmailText({
    intro: [
      `${input.orgName} wants to claim ${input.domain} on Memex.AI.`,
      `If you administer this domain and approve, use the link below:`,
    ],
    url: input.verifyUrl,
    closing: `If this wasn't expected, ignore it — the link expires on its own.`,
  });

  const html = renderEmailHtml({
    preheader: `${input.orgName} wants to claim ${input.domain} on Memex.AI.`,
    eyebrow: "Domain verification",
    heading: `Verify ${input.domain} for Memex.AI`,
    bodyParagraphs: [
      `<strong>${escapeHtml(input.orgName)}</strong> wants to claim <strong>${escapeHtml(input.domain)}</strong> on Memex.AI.`,
      `If you administer this domain, approve the request below.`,
    ],
    ctaLabel: "Verify domain",
    ctaUrl: input.verifyUrl,
    footerNote: `If this wasn't expected, ignore it — the link expires on its own.`,
  });

  return {
    to: input.to,
    subject: `Verify ${input.domain} for ${input.orgName} on Memex.AI`,
    text,
    html,
  };
}

export interface VerificationEmailInput {
  to: string;
  verifyUrl: string;
}

export function buildVerificationEmail(input: VerificationEmailInput): EmailMessage {
  const text = renderEmailText({
    intro: [`Confirm this email to finish creating your Memex:`],
    url: input.verifyUrl,
    closing: `Link expires in 24 hours. If this wasn't you, ignore this email.`,
  });

  const html = renderEmailHtml({
    preheader: "Confirm this email to finish creating your Memex.",
    eyebrow: "Email verification",
    heading: "Confirm your email",
    bodyParagraphs: [
      `Confirm this email to finish creating your Memex. The link expires in 24 hours.`,
    ],
    ctaLabel: "Confirm email",
    ctaUrl: input.verifyUrl,
    footerNote: `If this wasn't you, ignore this email — nothing will change.`,
  });

  return {
    to: input.to,
    subject: `Confirm your Memex.AI email`,
    text,
    html,
  };
}

export interface MagicLinkEmailInput {
  to: string;
  loginUrl: string;
}

export function buildMagicLinkEmail(input: MagicLinkEmailInput): EmailMessage {
  const text = renderEmailText({
    intro: [`Your single-use sign-in link (expires in 15 minutes):`],
    url: input.loginUrl,
    closing: `Didn't ask for this? Someone probably mistyped their email — no action needed.`,
  });

  const html = renderEmailHtml({
    preheader: "Single-use sign-in link, expires in 15 minutes.",
    eyebrow: "Sign-in link",
    heading: "Sign in to Memex.AI",
    bodyParagraphs: [
      `Your single-use sign-in link. It expires in 15 minutes.`,
    ],
    ctaLabel: "Sign in",
    ctaUrl: input.loginUrl,
    footerNote: `Didn't ask for this? Someone probably mistyped their email — no action needed.`,
  });

  return {
    to: input.to,
    subject: `Your Memex.AI sign-in link`,
    text,
    html,
  };
}

export interface WaitlistConfirmationEmailInput {
  to: string;
  name: string;
  company?: string;
}

export function buildWaitlistConfirmationEmail(
  input: WaitlistConfirmationEmailInput,
): EmailMessage {
  const org = input.company?.trim() || "your Org";

  const shareSubject = "Join me on the Memex.AI waitlist";
  const shareBody =
    "Hey — I just joined the Memex.AI waitlist. They're prioritising Orgs, so if a few of us sign up with our work emails we all move up the queue together. Worth a look: https://memex.ai";
  const mailtoUrl = `mailto:?subject=${encodeURIComponent(shareSubject)}&body=${encodeURIComponent(shareBody)}`;

  const text = renderEmailText({
    intro: [
      `You're on the Memex.AI waitlist, ${input.name}.`,
      `Thanks for signing up. We'll reach out as soon as your spot opens up.`,
      `One thing worth knowing: Memex.AI works best when a whole Org uses it together, so we're prioritising Orgs over individuals. Every colleague from ${org} who joins the waitlist bumps you further up the queue.`,
      `Easy way to help: forward this email to your colleagues. Make sure everyone signs up with their work email (that's how we match people to ${org}) — each new joiner moves you up.`,
    ],
    closing: `Questions? Just reply — a real person reads every one.`,
  });

  const html = renderEmailHtml({
    preheader: `You're on the waitlist — Org sign-ups jump the queue.`,
    eyebrow: "Waitlist",
    heading: `You're on the list, ${input.name}`,
    bodyParagraphs: [
      `Thanks for signing up. We'll reach out as soon as your spot opens up.`,
      `One thing worth knowing: <strong>Memex.AI works best when a whole Org uses it together</strong>, so we're prioritising Orgs over individuals. Every colleague from <strong>${escapeHtml(org)}</strong> who joins the waitlist bumps you further up the queue.`,
      `Easy way to help: forward this email to your colleagues. Make sure everyone signs up with their <strong>work email</strong> — that's how we match people to ${escapeHtml(org)}, and each new joiner moves you up.`,
    ],
    ctaLabel: "Forward to your colleagues",
    ctaUrl: mailtoUrl,
    footerNote: `Questions? Just reply to this email — a real person reads every one.`,
  });

  return {
    to: input.to,
    subject: `You're on the Memex.AI waitlist`,
    text,
    html,
  };
}

export interface McpCanonicalRefsSwitchEmailInput {
  to: string;
  tokensUrl: string;
}

// b-36 — one-time announcement to active MCP token holders that the MCP tool
// surface has switched to canonical refs. Sent via the
// scripts/notify-mcp-canonical-refs.ts one-shot script (with --execute);
// `--dry-run` mode lists recipients without sending.
export function buildMcpCanonicalRefsSwitchEmail(
  input: McpCanonicalRefsSwitchEmailInput,
): EmailMessage {
  const text = renderEmailText({
    intro: [
      `The Memex.AI MCP tool surface has switched to canonical refs.`,
      `What this means: tool arguments now take a single \`ref\` string (e.g. \`mindset/website-rewrite/briefs/b-1\`) instead of UUIDs. Responses include \`ref:\` lines you can copy and paste back into a follow-up call. Any tool call that passes a UUID will now return a structured error ("UUID inputs no longer accepted").`,
      `Action needed: reload your MCP client so it picks up the new tool definitions. \`mcp-remote\` users (Claude Desktop): nothing to do — it reconnects automatically on next request. Native HTTP clients (Claude Code): the new schemas land on next session start.`,
      `Your existing MCP tokens are unchanged. You can review or rotate them at:`,
    ],
    url: input.tokensUrl,
    closing: `Questions? Reply to this email — a real person reads every one.`,
  });

  const html = renderEmailHtml({
    preheader: "MCP tool surface switched to canonical refs — reload your client.",
    eyebrow: "Heads up",
    heading: "Memex MCP tool surface updated",
    bodyParagraphs: [
      `The Memex.AI MCP tool surface has switched to <strong>canonical refs</strong>. Tool arguments now take a single <code>ref</code> string (e.g. <code>mindset/website-rewrite/briefs/b-1</code>) instead of UUIDs. Responses include <code>ref:</code> lines you can copy back into a follow-up call.`,
      `<strong>Action needed:</strong> reload your MCP client so it picks up the new tool definitions. <code>mcp-remote</code> reconnects automatically on next request; native HTTP clients (Claude Code, Claude Desktop) pick up new schemas on next session start.`,
      `Any tool call that passes a UUID will return a structured error (<code>"UUID inputs no longer accepted"</code>). Your existing tokens are unchanged — review or rotate them below.`,
    ],
    ctaLabel: "Open MCP token settings",
    ctaUrl: input.tokensUrl,
    footerNote: `Questions? Reply to this email — a real person reads every one.`,
  });

  return {
    to: input.to,
    subject: `Memex MCP tool surface updated — please reload your MCP client`,
    text,
    html,
  };
}

export interface PasswordResetEmailInput {
  to: string;
  resetUrl: string;
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const text = renderEmailText({
    intro: [
      `Someone asked to reset your Memex.AI password. If that was you, pick a new one:`,
    ],
    url: input.resetUrl,
    closing: `Link expires in 1 hour. If this wasn't you, ignore it — your password stays the same.`,
  });

  const html = renderEmailHtml({
    preheader: "Reset your Memex.AI password.",
    eyebrow: "Password reset",
    heading: "Reset your password",
    bodyParagraphs: [
      `Someone asked to reset your password. If that was you, pick a new one below. The link expires in 1 hour.`,
    ],
    ctaLabel: "Reset password",
    ctaUrl: input.resetUrl,
    footerNote: `If this wasn't you, ignore this email — your password stays the same.`,
  });

  return {
    to: input.to,
    subject: `Reset your Memex.AI password`,
    text,
    html,
  };
}
