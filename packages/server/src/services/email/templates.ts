import type { EmailMessage } from "./sender.js";

// ──────────────────────────────────────────────────────────────────────────
// Shared HTML layout
// ──────────────────────────────────────────────────────────────────────────
// White background, Memex.AI brand accents (coral→magenta gradient for the CTA
// and a top bar). Inline CSS only — no <style> blocks, no build step — so it
// renders consistently across Gmail, Apple Mail, Outlook, etc.

const BRAND_INK = "#0E1128";
const BRAND_ACCENT = "#0482DC";
const BRAND_SKY = "#0C9FE3";
const BRAND_MUTED = "#6B7280";
const BRAND_BORDER = "#E5E7EB";
const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// spec-226 dec-2 — reusable layout primitives the activation/welcome emails need.
export interface EmailStep {
  label: string; // e.g. "// Step 1"
  title: string;
  body: string;
}
export interface EmailResource {
  title: string;
  description: string;
  url: string;
}

interface RenderInput {
  preheader: string;
  // Optional headline. Omit or pass "" → the email leads straight into
  // bodyParagraphs with no <h1> (spec-488: the welcome v2 carries no repeated
  // headline). Every other email passes a non-empty heading and is unchanged.
  heading?: string;
  // Interpreted as HTML — caller must escape any dynamic values it interpolates.
  bodyParagraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
  footerNote: string;
  // Optional layout blocks (spec-226 dec-2). Absent → not rendered (the existing
  // 6 emails set neither and render exactly as before).
  steps?: EmailStep[];
  resources?: EmailResource[];
  // Body paragraphs rendered AFTER the CTA, before the resources block — the
  // "we'll send you a few emails…" prose + sign-off the activation/welcome emails
  // carry. Absent → nothing rendered.
  afterCtaParagraphs?: string[];
  // The auth emails show a "paste this link" line; activation/welcome emails don't.
  // Defaults to true so the existing 6 emails are unchanged.
  showPasteLink?: boolean;
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
  parts.push(input.closing, "Memex AI");
  return parts.join("\n\n");
}

// spec-226 dec-2 — the step block ("// Step 1" label / title / body), stacked
// vertically. Inline styles, no imagery. Returns "" when there are no steps.
export function renderSteps(steps?: EmailStep[]): string {
  if (!steps?.length) return "";
  return steps
    .map(
      (s) =>
        `<div style="margin:20px 0;">` +
        `<div style="font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${BRAND_ACCENT};">${escapeHtml(s.label)}</div>` +
        `<div style="margin:6px 0 2px;font-size:16px;font-weight:600;color:${BRAND_INK};">${escapeHtml(s.title)}</div>` +
        `<div style="color:${BRAND_INK};font-size:15px;line-height:1.6;">${escapeHtml(s.body)}</div>` +
        `</div>`,
    )
    .join("");
}

// spec-226 dec-2 — the "resources" block: a TABLE of title-link + description
// rows (a table construct, NOT image buttons, per the Postmark constraints).
// Returns "" when there are no resources.
export function renderResources(resources?: EmailResource[]): string {
  if (!resources?.length) return "";
  const rows = resources
    .map(
      (r) =>
        `<tr><td style="padding:12px 0;border-top:1px solid ${BRAND_BORDER};">` +
        `<a href="${escapeHtml(r.url)}" style="color:${BRAND_ACCENT};font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(r.title)}</a>` +
        `<div style="margin-top:2px;color:${BRAND_MUTED};font-size:13px;line-height:1.5;">${escapeHtml(r.description)}</div>` +
        `</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">${rows}</table>`;
}

// spec-480 — hosted email video + clickable thumbnail assets (dec-1/dec-2).
// Public objects on the prod static bucket (same bucket + media/ path as the
// /welcome video). Stable, non-expiring, immutable-cached. SHARED with the
// welcome email (spec-488) — hence neutral `email-*` object names, not `winback-*`.
// The base video URL is shared; each builder appends its OWN utm_campaign so a
// click is attributable to the right email (dec-6). A swap must mint a NEW
// versioned object (…-v2) — never a same-name overwrite (immutable cache).
export const EMAIL_EXPLAINER_VIDEO_URL =
  "https://storage.googleapis.com/memex-ai-prod-app-static/media/email-explainer-60s.mp4";
export const EMAIL_VIDEO_THUMB_1X_URL =
  "https://storage.googleapis.com/memex-ai-prod-app-static/media/email-video-thumb-480.png";
export const EMAIL_VIDEO_THUMB_2X_URL =
  "https://storage.googleapis.com/memex-ai-prod-app-static/media/email-video-thumb-960.png";
// The still Christine chose (spec-480 s-5) — used as the thumbnail alt (dec-4).
export const EMAIL_VIDEO_TITLE =
  "The spec-driven development system for AI coding agents";

// spec-487 dec-3 (t-1) — the three per-email HOW-TO videos (Day-2 / Day-3 / Day-12),
// hosted on the SAME static bucket + media/ path as the explainer (spec-480 pattern):
// stable, public, non-expiring, immutable-cached. Uploaded + verified public 2026-07-17.
// Distinct from EMAIL_EXPLAINER_VIDEO_URL ("what is Memex") — these each show HOW to do
// that email's action. Each builder appends its OWN utm_campaign (dec-6); a swap mints a
// NEW versioned object (…-v2), never a same-name overwrite (immutable cache).
const EMAIL_MEDIA_BASE =
  "https://storage.googleapis.com/memex-ai-prod-app-static/media";
export interface HowToVideoAsset {
  videoUrl: string;
  thumb1xUrl: string;
  thumb2xUrl: string;
}
function howToAsset(slug: string): HowToVideoAsset {
  return {
    videoUrl: `${EMAIL_MEDIA_BASE}/${slug}.mp4`,
    thumb1xUrl: `${EMAIL_MEDIA_BASE}/${slug}-thumb-480.png`,
    thumb2xUrl: `${EMAIL_MEDIA_BASE}/${slug}-thumb-960.png`,
  };
}
export const EMAIL_HOWTO_CREATE_SPEC = howToAsset("email-howto-create-spec"); // Day-2 "create a spec"
export const EMAIL_HOWTO_CONNECT_MCP = howToAsset("email-howto-connect-mcp"); // Day-3 "connect MCP + spec"
export const EMAIL_HOWTO_CONNECT_PEOPLE = howToAsset("email-howto-connect-people"); // Day-12 "connect with people"

// spec-480 dec-2/dec-3/dec-4 — the clickable video-thumbnail block: a single
// static poster image (play button baked in, dec-3) hyperlinked to the hosted
// mp4. Returned as an HTML string injected into `bodyParagraphs` (mid-body, so
// the video sits above the fold) — `<a>`/`<img>` are phrasing content, valid in
// the renderer's <p> wrapper, so this needs no change to renderEmailHtml and
// touches none of the other (image-free) emails. Bulletproof/table-safe:
// `border:0`+`outline:none` kill Outlook's blue link border; explicit
// width/height + `display:block`; `srcset` serves retina where supported
// (Gmail/Outlook fall back to the 1x `src`). 480px = the email's content width
// (560 − 2×40 padding). The image-blocked fallback (dec-4) is a SEPARATE visible
// body line built by the caller — see `renderVideoFallbackLine`.
export function renderVideoThumbnail(opts: {
  videoUrl: string;
  thumb1xUrl: string;
  thumb2xUrl: string;
  alt: string;
}): string {
  const href = escapeHtml(opts.videoUrl);
  return (
    `<a href="${href}" style="display:block;border:0;outline:none;text-decoration:none;">` +
    `<img src="${escapeHtml(opts.thumb1xUrl)}" srcset="${escapeHtml(opts.thumb2xUrl)} 2x" ` +
    `width="480" height="269" alt="${escapeHtml(opts.alt)}" ` +
    `style="display:block;width:100%;max-width:480px;height:auto;border:0;outline:none;text-decoration:none;border-radius:8px;">` +
    `</a>`
  );
}

// spec-480 dec-4 — the image-blocked fallback: a visible text line so the video
// is never unreachable when a client blocks images. "Watch it here" is the brand
// accent (#0482DC, spec-468) and links the same video URL.
export function renderVideoFallbackLine(videoUrl: string): string {
  return (
    `Can't see the video above? ` +
    `<a href="${escapeHtml(videoUrl)}" style="color:${BRAND_ACCENT};text-decoration:none;">Watch it here</a>`
  );
}

function renderEmailHtml(input: RenderInput): string {
  const paragraphs = input.bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:${BRAND_INK};font-size:16px;line-height:1.6;">${p}</p>`,
    )
    .join("");

  const safeUrl = escapeHtml(input.ctaUrl);
  // spec-488 — suppress the <h1> when no heading is given (welcome v2 leads with
  // the greeting). Title falls back to the preheader so it is never empty.
  const headingHtml = input.heading
    ? `<h1 style="margin:0 0 16px;color:${BRAND_INK};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;">${escapeHtml(input.heading)}</h1>`
    : "";
  const titleText = input.heading || input.preheader;
  const stepsHtml = renderSteps(input.steps);
  const resourcesHtml = renderResources(input.resources);
  const pasteLink = (input.showPasteLink ?? true)
    ? `<p style="margin:16px 0 0;color:${BRAND_MUTED};font-size:13px;line-height:1.5;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:${BRAND_SKY};word-break:break-all;">${safeUrl}</a></p>`
    : "";
  const afterCta = (input.afterCtaParagraphs ?? [])
    .map(
      (p) => `<p style="margin:16px 0 0;color:${BRAND_INK};font-size:15px;line-height:1.6;">${p}</p>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(titleText)}</title>
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
              <td style="padding:32px 40px;">
                <div style="margin:0 0 20px;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND_INK};">Memex AI</div>
                ${headingHtml}
                ${paragraphs}
                ${stepsHtml}
                <div style="margin:24px 0 8px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:${BRAND_ACCENT};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escapeHtml(input.ctaLabel)}</a>
                </div>
                ${pasteLink}
                ${afterCta}
                ${resourcesHtml}
                <div style="margin:28px 0 0;padding-top:20px;border-top:1px solid ${BRAND_BORDER};">
                  <p style="margin:0;color:${BRAND_MUTED};font-size:12px;line-height:1.5;">${escapeHtml(input.footerNote)}</p>
                  <p style="margin:8px 0 0;color:${BRAND_MUTED};font-size:12px;line-height:1.5;"><a href="https://memex.ai" style="color:${BRAND_MUTED};">memex.ai</a></p>
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
    closing: `The link expires in 24 hours. You're getting this because this email was used to sign up for Memex.AI — if that wasn't you, you can safely ignore it.`,
  });

  const html = renderEmailHtml({
    preheader: "Confirm this email to finish creating your Memex.",
    heading: "Confirm your email",
    bodyParagraphs: [
      `Confirm this email to finish creating your Memex. The link expires in 24 hours.`,
    ],
    ctaLabel: "Confirm email",
    ctaUrl: input.verifyUrl,
    footerNote: `You're getting this because this email was used to sign up for Memex.AI. If that wasn't you, you can safely ignore this message — the link expires on its own.`,
  });

  return {
    to: input.to,
    subject: `Confirm your Memex.AI email`,
    text,
    html,
    // spec-12 t-9 / dec-7: stamp a distinct, stable comms type so the signup
    // confirmation email is identifiable in comms_log — Backstage's stuck-signup
    // worklist joins on type='email_verification' instead of brittle subject
    // matching. Both call sites (routes/auth/password.ts signup + resend) send this
    // EmailMessage, so the type travels with the template; recordEmailComm stores it
    // (else it would default to 'transactional', the password-reset/magic-link bucket).
    commsType: "email_verification",
  };
}

export interface WelcomeEmailInput {
  to: string;
  /** The app URL the CTA opens — derive from APP_BASE_URL so int/prod links differ. */
  appUrl: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there," (spec-428 dec-1). */
  firstName?: string;
  /** Sign-off name; the concrete person comes from config (std-31), not hardcoded. */
  senderName?: string;
}

// spec-480 dec-6 / spec-488 t-2 — the welcome links the SAME hosted explainer cut
// as the win-back email (spec-480), tagged utm_campaign=welcome so a welcome-video
// click is attributable separately from the win-back's (WINBACK_VIDEO_URL). The UTM
// on a raw GCS mp4 is only meaningful once Postmark rewrites the link, so the send
// carries trackLinks. (utm_source/medium mirror the win-back for one grouping.)
const WELCOME_VIDEO_URL = `${EMAIL_EXPLAINER_VIDEO_URL}?utm_source=lifecycle&utm_medium=email&utm_campaign=welcome`;

// spec-488 t-1 — the day-one welcome, v2 copy (supersedes spec-428's Option 3;
// source of truth is spec-488 s-2). Renders through the shared renderer and LEADS
// WITH THE GREETING — no repeated H1 headline (heading: ""). Transactional stream,
// always sends; logged under the stable `welcome` key (spec-428 dec-7, inherited).
// The clickable explainer-video thumbnail (spec-480 mechanism) is wired at the
// spec-488 t-2 seam marked below; until then the email carries copy only and the
// video degrades to nothing (t-2 adds the thumbnail + image-blocked fallback).
export function buildWelcomeEmail(input: WelcomeEmailInput): EmailMessage {
  const firstName = input.firstName?.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  // spec-451 ac-5 — sign-off on two lines ("Best," / name). Two forms: \n for the
  // plain-text body, <br> for the HTML (afterCtaParagraphs is inserted un-escaped).
  const senderName = input.senderName?.trim() || "The Memex AI team";
  const signOffText = `Best,\n${senderName}`;
  const signOffHtml = `Best,<br>${escapeHtml(senderName)}`;

  const intro = "Glad you're on board. Here's why frontier teams build on Memex:";
  const para1 =
    "We all went all in on MD docs for building with AI: first for specifying features, then for passing context between humans and agents at scale. Exciting at first (we did it too!).";
  // spec-488 s-2 — the "sh*t" spelling is a deliberate voice choice; the asterisk
  // softens spam-filter risk. Accepted for the day-one transactional send.
  const para2 =
    "The problem? They're sh*t because they're only documents. They don't force agents to build specific things, so agents interpret, skip parts, and make executive decisions without your say-so. That's why AI coding gets so frustrating. And as the way you pass context, they go stale, need versions, and turn chaotic fast: a burst of productivity, then a ceiling.";
  const fix1 =
    "Your docs become living specs. Each decision becomes a perfectly scoped agent task with an acceptance criterion that forces the agent to build exactly what you want. Right the first time (yes, it's as good as it sounds).";
  const fix2 =
    "Each spec then speeds up the next. Memex surfaces what teammates are deciding in real time and tells you how it impacts your build, compounding into a knowledge layer that makes every new spec faster. No docs, no folders, no upkeep (finally!).";
  const bullet1 = "Connect your agent over MCP (Claude Code, Cursor, Codex, Copilot)";
  const bullet2 = "Create your first spec";

  const text = renderEmailText({
    intro: [
      greeting,
      intro,
      para1,
      para2,
      "Memex fixes both:",
      `1. ${fix1}`,
      `2. ${fix2}`,
      "Here's a short animated walkthrough:",
      `Watch the video: ${WELCOME_VIDEO_URL}`,
      "To start:",
      `- ${bullet1}`,
      `- ${bullet2}`,
    ],
    url: input.appUrl,
    closing: signOffText,
  });

  const html = renderEmailHtml({
    preheader: "Why frontier teams build on Memex — right the first time.",
    // No heading — v2 leads with the greeting (spec-488 s-2, headline dropped).
    heading: "",
    bodyParagraphs: [
      escapeHtml(greeting),
      escapeHtml(intro),
      escapeHtml(para1),
      escapeHtml(para2),
      "<strong>Memex fixes both:</strong>",
      `<strong>1.</strong> ${escapeHtml(fix1)}`,
      `<strong>2.</strong> ${escapeHtml(fix2)}`,
      escapeHtml("Here's a short animated walkthrough:"),
      // spec-488 t-2 — the clickable video thumbnail + image-blocked fallback,
      // reusing spec-480's shared hosted-video + `email-*` thumbnail assets.
      renderVideoThumbnail({
        videoUrl: WELCOME_VIDEO_URL,
        thumb1xUrl: EMAIL_VIDEO_THUMB_1X_URL,
        thumb2xUrl: EMAIL_VIDEO_THUMB_2X_URL,
        alt: `Watch: ${EMAIL_VIDEO_TITLE}`,
      }),
      renderVideoFallbackLine(WELCOME_VIDEO_URL),
      `<strong>To start:</strong><br>&bull; ${escapeHtml(bullet1)}<br>&bull; ${escapeHtml(bullet2)}`,
    ],
    ctaLabel: "Open Memex AI",
    ctaUrl: input.appUrl,
    showPasteLink: false,
    afterCtaParagraphs: [signOffHtml],
    footerNote: "You're getting this because you signed up for Memex AI, built by Mindset AI.",
  });

  return {
    to: input.to,
    subject:
      "Agents that build it right first time, and every spec speeds up the next",
    text,
    html,
    commsType: "welcome",
    // spec-488 t-2 / spec-480 dec-6 — enable Postmark click tracking so a click on
    // the video thumbnail / fallback link (the raw GCS mp4) is recorded and the
    // utm_campaign=welcome attribution is real. Click tracking only, no open pixel.
    trackLinks: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// spec-427 — activation & win-back emails (Slice A: pure render)
// ──────────────────────────────────────────────────────────────────────────
// Two lifecycle emails that recover stalled signups (dec-6: the code is the
// canonical authoring source; s-2 mirrors this copy). Both render through the
// SAME shared renderEmailHtml() using the spec-226 step/resources primitives —
// no parallel/raw-HTML path, CTA + resources are table / inline-CSS constructs,
// no imagery (ac-10). App deep-link CTAs come in as inputs derived from
// APP_BASE_URL at the send site (dec-8), never a hardcoded host.
//
// These builders are PURE RENDER: no cohort/timing/send logic, no env reads. The
// team-identity From + monitored Reply-To (dec-1) are applied at the send site
// from EMAIL_ACTIVATION_FROM / EMAIL_ACTIVATION_REPLY_TO — identical to the
// welcome (welcome-send.ts), NOT set in the builder (see spec-427 t-1 drift note).
// commsType IS stamped here (static, send-independent): Slice B's dedup/cap counts
// these stable keys in comms_log (ac-14 / dec-7) and never reaches back for copy.

// Shared "Resources to get started" block — identical across both activation
// emails (s-2). Rendered as a table, not image buttons (Postmark constraints).
const ACTIVATION_RESOURCES: EmailResource[] = [
  {
    title: "Understanding Memex AI",
    description: "The 10-minute read on why it exists and how it works.",
    url: "https://www.memex.ai/understanding-memex.pdf",
  },
  {
    title: "Documentation",
    description: "The complete reference, from getting started to the deep technical detail.",
    url: "https://www.memex.ai/docs",
  },
  {
    title: "Community",
    description: "Say hello on Discord, whether you're weighing Memex up or already building.",
    url: "https://discord.com/invite/WJfBYG9eV",
  },
];

function activationGreeting(firstName?: string): string {
  const name = firstName?.trim();
  return name ? `Hi ${name},` : "Hi there,";
}

// spec-451 ac-5 — sign-off on two lines (see buildWelcomeEmail). \n for the plain-text
// body, <br> for the HTML (afterCtaParagraphs is inserted un-escaped).
const ACTIVATION_SIGNOFF_TEXT = "Best,\nThe Memex AI team";
const ACTIVATION_SIGNOFF_HTML = "Best,<br>The Memex AI team";
const ACTIVATION_FOOTER =
  "You're getting this because you signed up for Memex AI, built by Mindset AI.";

export interface ConnectedInactiveEmailInput {
  to: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there,". */
  firstName?: string;
  /** CTA "Create a spec" deep-link — derived from APP_BASE_URL at the send site (dec-8). */
  createSpecUrl: string;
  /** Link to the user's own Memex ("your Memex") — derived from APP_BASE_URL (dec-8). */
  memexUrl: string;
}

// Email 1 — connected-but-inactive (MCP connected, no tool call, no Spec).
// Subject "Memex is connected. Here's what to do next." · CTA "Create a spec".
// spec-487 dec-6 — the Day-2 how-to video ("create a spec"), attributable via its
// own utm_campaign (distinct from the win-back + welcome, which use the explainer).
const CONNECTED_INACTIVE_VIDEO_URL = `${EMAIL_HOWTO_CREATE_SPEC.videoUrl}?utm_source=lifecycle&utm_medium=email&utm_campaign=connected_inactive`;

// spec-487 (t-2) — the Day-2 "Connected but no Spec" email, v2 copy (s-2) + how-to
// video. Leads with the greeting (no headline, like the welcome v2). The video is a
// clickable poster + image-blocked fallback line (spec-480 pattern, dec-4) — NO
// separate "Watch the 3-min guide" button (dec-4: one video, one link). commsType /
// dedup key unchanged (activation.connected_inactive).
export function buildConnectedInactiveEmail(
  input: ConnectedInactiveEmailInput,
): EmailMessage {
  const greeting = activationGreeting(input.firstName);
  const p1 =
    "Memex is connected, but the change you signed up for does not show until there is a Spec. Without one, your agent is still working off a document: it reads what it likes, skips the rest, and fills the gaps with its own assumptions, so you are back to re-prompting and re-reviewing.";
  const p2 =
    "A Memex spec fixes that. You create it right from your coding agent: it reads your repo, and together you work through the major decisions and the why behind what you are building. Each one becomes a task with an acceptance criterion your agent has to build to, not prose it can pass over. The more you settle upfront, the more it gets right first time.";
  const videoIntro = "See it done in 3 minutes: a quick guide to creating your first spec.";
  const thenBring = "Then bring one small piece of work and paste this into your coding agent:";
  const prompt1 =
    "I want to create a new spec in Memex for [your idea]. Look at my codebase, and let's work through the major decisions and why we're building it.";
  const rollingIntro = "Once you are rolling, these help too:";
  const rollingPrompts = [
    "Let's work through the decisions",
    "What's our standard for this?",
    "What's outstanding before we build?",
    "Move to build and implement this in a worktree",
  ];
  const stuck = "Stuck? Reply here, or find us in #help on Discord.";

  const text = renderEmailText({
    intro: [
      greeting,
      p1,
      p2,
      `${videoIntro} Watch it here: ${CONNECTED_INACTIVE_VIDEO_URL}`,
      thenBring,
      `"${prompt1}"`,
      rollingIntro,
      ...rollingPrompts.map((p) => `"${p}"`),
      stuck,
    ],
    url: input.createSpecUrl,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "Memex is connected — one Spec turns it into output.",
    // No headline — v2 leads with the greeting (spec-488 renderer supports this).
    heading: "",
    bodyParagraphs: [
      escapeHtml(greeting),
      escapeHtml(p1),
      escapeHtml(p2),
      escapeHtml(videoIntro),
      renderVideoThumbnail({
        videoUrl: CONNECTED_INACTIVE_VIDEO_URL,
        thumb1xUrl: EMAIL_HOWTO_CREATE_SPEC.thumb1xUrl,
        thumb2xUrl: EMAIL_HOWTO_CREATE_SPEC.thumb2xUrl,
        alt: "Watch: how to create your first spec",
      }),
      renderVideoFallbackLine(CONNECTED_INACTIVE_VIDEO_URL),
      escapeHtml(thenBring),
      `<em>&ldquo;${escapeHtml(prompt1)}&rdquo;</em>`,
    ],
    ctaLabel: "Create a spec",
    ctaUrl: input.createSpecUrl,
    showPasteLink: false,
    afterCtaParagraphs: [
      escapeHtml(rollingIntro),
      rollingPrompts.map((p) => `&ldquo;${escapeHtml(p)}&rdquo;`).join("<br>"),
      escapeHtml(stuck).replace(
        "#help",
        `<a href="${DISCORD_INVITE_URL}" style="color:${BRAND_ACCENT};text-decoration:none;">#help</a>`,
      ),
      ACTIVATION_SIGNOFF_HTML,
    ],
    resources: ACTIVATION_RESOURCES,
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "Connected, but the output has not changed yet",
    text,
    html,
    // spec-427 ac-14 / dec-7: stable comms key — dedup counts this key in comms_log,
    // never the subject line. Unchanged from v1 (spec-487 keeps the key).
    commsType: "activation.connected_inactive",
    // spec-487 dec-6 — the video link is a raw GCS mp4; Postmark click-tracking makes
    // the utm_campaign attributable (same as the win-back).
    trackLinks: true,
  };
}

export interface SignedInDormantEmailInput {
  to: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there,". */
  firstName?: string;
  /** CTA "Open Memex AI" target — derived from APP_BASE_URL at the send site (dec-8). */
  appUrl: string;
}

// Email 2 — signed-in-but-dormant (signed in, identity complete, MCP never
// connected). Subject "You're two steps from your first Spec" · CTA "Open Memex AI".
export function buildSignedInDormantEmail(
  input: SignedInDormantEmailInput,
): EmailMessage {
  const greeting = activationGreeting(input.firstName);
  const value =
    "Once you're in, your agents build from what you actually decided, not what they guessed. Every decision is captured as you go, so nothing important gets buried in a chat thread or quietly chosen for you mid-build. And done means verified, not just claimed. No more vibe coding.";
  const afterCtaText =
    "We'll send you a few short emails over the next few weeks, and there are some resources below to get you started. If you get stuck, just reply here or find us in #help on Discord.";
  // spec-465: link "#help" to the Discord invite in the HTML body only (coral).
  // escapeHtml leaves the literal "#help" untouched, so replacing it on the
  // escaped string is safe; the plain-text body keeps "#help" as prose.
  const afterCtaHtml = escapeHtml(afterCtaText).replace(
    "#help",
    `<a href="${DISCORD_INVITE_URL}" style="color:${BRAND_ACCENT};text-decoration:none;">#help</a>`,
  );

  const steps: EmailStep[] = [
    {
      label: "// Step 1",
      title: "Connect to the Memex MCP",
      body: "The app shows you exactly how to connect, whatever coding agent you're using.",
    },
    {
      label: "// Step 2",
      title: "Create your first Spec",
      body: "Bring an idea and we'll help you shape it, start to finish.",
    },
  ];

  const text = renderEmailText({
    intro: [
      greeting,
      "Getting Memex set up takes two simple steps.",
      value,
      "// Step 1 — Connect to the Memex MCP: The app shows you exactly how to connect, whatever coding agent you're using.",
      "// Step 2 — Create your first Spec: Bring an idea and we'll help you shape it, start to finish.",
      afterCtaText,
    ],
    url: input.appUrl,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "You're two steps from your first Spec.",
    heading: "You're two steps from your first Spec",
    bodyParagraphs: [
      escapeHtml(greeting),
      "Getting Memex set up takes two simple steps.",
      escapeHtml(value),
    ],
    steps,
    ctaLabel: "Open Memex AI",
    ctaUrl: input.appUrl,
    showPasteLink: false,
    afterCtaParagraphs: [afterCtaHtml, ACTIVATION_SIGNOFF_HTML],
    resources: ACTIVATION_RESOURCES,
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "You're two steps from your first Spec",
    text,
    html,
    // spec-427 ac-14 / dec-7: stable comms key (see Email 1).
    commsType: "activation.signed_in_dormant",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// spec-480 — win-back email (single video-centric re-intro)
// ──────────────────────────────────────────────────────────────────────────
// One warm re-intro built around the clickable explainer-video thumbnail, sent
// to the SINGLE `signed_in_dormant` cohort — verified, never connected an MCP,
// no Spec (dec-9). The `connected_inactive` cohort is deliberately NOT a
// recipient (its members have already connected, so this email's one CTA —
// "Connect your agent" — would be nonsensical); it has its own Day-2 email (spec-487).
// So there is ONE segment: one fixed stall-line, one CTA, no per-segment branch.
//
// PURE RENDER like the spec-427 builders: no cohort/timing/send/env logic. The
// team-identity From + monitored Reply-To + broadcast stream + suppression are
// applied at the send site by sendLifecycleEmail; commsType IS stamped here.
//
// The one intentional image in the lifecycle program: the video thumbnail
// (dec-2 overturned spec-427's self-imposed "no imagery" rule for this image
// only). It renders via the shared renderVideoThumbnail primitive injected into
// bodyParagraphs, so the rest of the email stays the same table/inline-CSS,
// image-free construct as the others.

// spec-480 dec-6 — UTM on the video link so a click is attributable to THIS
// email (vs the welcome email, spec-488, which links the same asset with
// utm_campaign=welcome). Postmark link-tracking (t-4) records the click server-side.
// spec-487 (t-3) — the win-back now carries the "connect the MCP + create a spec"
// how-to video (replacing the "what is Memex" explainer, which stays on the welcome).
// utm_campaign=winback keeps the click attributable to this email.
const WINBACK_VIDEO_URL = `${EMAIL_HOWTO_CONNECT_MCP.videoUrl}?utm_source=lifecycle&utm_medium=email&utm_campaign=winback`;

export interface WinbackEmailInput {
  to: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there,". */
  firstName?: string;
  /**
   * CTA "Connect your agent" target — the one-click desktop connect flow (dec-9).
   * Derived at the send site (dec-8 / std-2 via buildAppBaseUrl), never a hardcoded
   * host here. t-3 resolves what this concretely is (the desktop-app download at
   * www.memex.ai/download is the current one-click MCP-setup path, spec-460).
   */
  connectUrl: string;
}

export function buildWinbackEmail(input: WinbackEmailInput): EmailMessage {
  const name = input.firstName?.trim();
  const greeting = name ? `Hi ${name},` : "Hi there,";

  // spec-487 s-3 copy (the code is the canonical authoring source; s-3 mirrors it).
  const p1 =
    "Right now your agent works from markdown: files it interprets, skips, and fills in with its own assumptions. That is what drives the re-prompting and re-reviewing, and it only gets worse on brownfield code.";
  const p2 = "Memex never touches your repo, but your coding agent does.";
  const p3 =
    "So connecting the MCP makes your agent the bridge: it reads your real codebase, and everything you decide gets grounded in it, in one place instead of scattered across threads and MD files. Once connected, you start speccing against your actual code, not a blank page, and the more decisions you settle upfront, the more your agent gets right first time.";
  const videoIntro =
    "See it done in 3 minutes: a quick guide to connecting the MCP and creating your first spec.";
  const connectIntro = "Connect your MCP & create a spec:";
  const connectStep =
    "To connect the MCP, open Settings then Integrations in Memex and copy the MCP connection prompt. Paste that into your coding agent and it wires up the MCP for you.";
  const thenSpec = "Then create your first spec. Paste this in:";
  const prompt1 =
    "I want to create a new spec in Memex for [your idea or MD doc name]. Look at my codebase, and let's work through the major decisions and why we're building it.";
  const rollingIntro = "Once you have a few specs, these are worth trying:";
  const rollingPrompts = [
    "What have we decided before that's similar to this?",
    "Which decisions conflict with this spec?",
    "Which existing specs make this one stronger?",
    "What's outstanding before we build?",
  ];
  const needHand = "Need a hand? Reply here, or find us in #help on Discord.";

  const text = renderEmailText({
    intro: [
      greeting,
      p1,
      p2,
      p3,
      `${videoIntro} Watch it here: ${WINBACK_VIDEO_URL}`,
      connectIntro,
      connectStep,
      `${thenSpec} "${prompt1}"`,
      rollingIntro,
      ...rollingPrompts.map((p) => `"${p}"`),
      needHand,
    ],
    url: input.connectUrl,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "Connect the MCP and your agent works from your real codebase, not markdown.",
    // No headline — v2 leads with the greeting (spec-488 renderer supports this).
    heading: "",
    bodyParagraphs: [
      escapeHtml(greeting),
      escapeHtml(p1),
      escapeHtml(p2),
      escapeHtml(p3),
      escapeHtml(videoIntro),
      renderVideoThumbnail({
        videoUrl: WINBACK_VIDEO_URL,
        thumb1xUrl: EMAIL_HOWTO_CONNECT_MCP.thumb1xUrl,
        thumb2xUrl: EMAIL_HOWTO_CONNECT_MCP.thumb2xUrl,
        alt: "Watch: how to connect the MCP and create a spec",
      }),
      renderVideoFallbackLine(WINBACK_VIDEO_URL),
      `<strong>${escapeHtml(connectIntro)}</strong>`,
      escapeHtml(connectStep),
      `${escapeHtml(thenSpec)}<br><em>&ldquo;${escapeHtml(prompt1)}&rdquo;</em>`,
    ],
    ctaLabel: "Connect your agent",
    ctaUrl: input.connectUrl,
    showPasteLink: false,
    afterCtaParagraphs: [
      escapeHtml(rollingIntro),
      rollingPrompts.map((p) => `&ldquo;${escapeHtml(p)}&rdquo;`).join("<br>"),
      escapeHtml(needHand).replace(
        "#help",
        `<a href="${DISCORD_INVITE_URL}" style="color:${BRAND_ACCENT};text-decoration:none;">#help</a>`,
      ),
      ACTIVATION_SIGNOFF_HTML,
    ],
    resources: ACTIVATION_RESOURCES,
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "Ground your specs in your actual codebase",
    text,
    html,
    // spec-480 dec-8 (re-resolved): the win-back REUSES the existing signed_in_dormant
    // comms key — it IS that cohort's email now. Minting a new "activation.winback" key
    // would have split the cross-repo comms-conversion contract (the metric is mirrored
    // byte-for-byte in memex-backstage via comms-conversion.fixture.ts); reusing the key
    // keeps that contract intact. Dedup (hasComm) + the activation-metrics join count THIS
    // key. (Win-back vs welcome-video click attribution still separates via the UTM above.)
    commsType: "activation.signed_in_dormant",
    // spec-480 dec-6 (ac-11): enable Postmark click tracking so a thumbnail/fallback
    // click on the raw-mp4 link is recorded (a GCS mp4 can't run JS; the UTM above only
    // labels the tracked URL). Click tracking only — no open pixel.
    trackLinks: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// spec-453 — "See it verified" + "Connect with people" (Slice A: pure render)
// ──────────────────────────────────────────────────────────────────────────
// Two more lifecycle touches in the same activation sequence as spec-427's two
// emails and spec-428's welcome. PURE RENDER, like the spec-427 builders: no
// trigger/timing/send/env logic here. Team-identity From/Reply-To + the broadcast
// stream + suppression are applied at the send site by sendLifecycleEmail (dec-5),
// NOT in the builder. commsType IS stamped here (static): the trigger (t-2) and the
// Day-12 pass (t-5) dedup on these stable keys in comms_log (dec-6), never the subject.

// The confirmed, permanent Discord invite (dec-8) — replaces the retired
// www.memex.ai/discord placeholder. Same link the welcome/resources already use.
const DISCORD_INVITE_URL = "https://discord.com/invite/WJfBYG9eV";

export interface VerifiedMilestoneEmailInput {
  to: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there,". */
  firstName?: string;
  /** CTA "Go to Memex AI" target — the user's Specs board, derived from APP_BASE_URL
   *  at the send site. dec-2: GENERIC board, no deep-link to the triggering spec/AC. */
  appUrl: string;
}

// spec-453 "See it verified" (dec-1/dec-2). The aha email: the first time a user's
// own acceptance criterion goes green via a tagged test event (the trigger lives in
// routes/test-events.ts — t-2; this is pure render). Generic/evergreen copy, no
// per-send personalization beyond the greeting (dec-2). Copy mirrors s-2.
export function buildVerifiedMilestoneEmail(
  input: VerifiedMilestoneEmailInput,
): EmailMessage {
  const greeting = activationGreeting(input.firstName);
  // spec-487 s-4 copy (copy-only rewrite, no video). Owned by spec-453 — coordinated.
  const p1 =
    "Congratulations. You just did something a markdown spec can never do: an acceptance criterion, verified in CI. It went green on its own, without you re-reading a diff and hoping the agent caught what mattered. That is proof that what you decided got built.";
  const p2 = "Two ways to make that compound.";
  const p3 =
    "First, run another Spec. Every one you finish makes the next faster, because your agents inherit what you have already decided.";
  const p4 =
    "Second, set up your standards. You already have rules written down in CLAUDE.md, AGENTS.md or your Cursor rules. Point your agent at them and paste this:";
  const prompt =
    "Read my CLAUDE.md and AGENTS.md, create Memex standards from the rules in them, then rewrite the MD file as a contents page that tells my agents which Memex standard applies to what.";
  const p5 =
    "An agent skims an MD file once and forgets it. Memex makes it check the relevant standard on every task it claims, so your rules get followed instead of just written down.";
  const needHand = "Questions? Reply here, or find us in #help on Discord.";

  const text = renderEmailText({
    intro: [greeting, p1, p2, p3, p4, `"${prompt}"`, p5, needHand],
    url: input.appUrl,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "A green check a markdown spec could never give you — here's how to compound it.",
    // No headline — v2 leads with the greeting (spec-488 renderer supports this).
    heading: "",
    bodyParagraphs: [
      escapeHtml(greeting),
      escapeHtml(p1),
      `<strong>${escapeHtml(p2)}</strong>`,
      escapeHtml(p3),
      escapeHtml(p4),
      `<em>&ldquo;${escapeHtml(prompt)}&rdquo;</em>`,
      escapeHtml(p5),
    ],
    ctaLabel: "Go to Memex AI",
    ctaUrl: input.appUrl,
    showPasteLink: false,
    afterCtaParagraphs: [
      escapeHtml(needHand).replace(
        "#help",
        `<a href="${DISCORD_INVITE_URL}" style="color:${BRAND_ACCENT};text-decoration:none;">#help</a>`,
      ),
      ACTIVATION_SIGNOFF_HTML,
    ],
    resources: ACTIVATION_RESOURCES,
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "Nice. A markdown spec could never give you that green check",
    text,
    html,
    // spec-453 dec-6: stable comms key — the trigger (t-2) dedups on THIS, never the subject.
    // Unchanged by spec-487 (copy-only rewrite).
    commsType: "activation.verified_milestone",
  };
}

export interface ConnectPeopleEmailInput {
  to: string;
  /** Recipient's first name; absent/empty → a graceful "Hi there,". */
  firstName?: string;
}

// spec-453 "Connect with people" (dec-7/dec-8). The closing Day-12 touch: no
// pressure, point to the community. Pure render; the Day-12 select/dedup/send is
// t-5, invoked by the shared scheduled endpoint (t-6). The only CTA is the confirmed
// permanent Discord invite (dec-8). Copy mirrors s-3.
// spec-487 (t-5) — the Day-12 how-to video, attributable via its own utm_campaign.
const CONNECT_PEOPLE_VIDEO_URL = `${EMAIL_HOWTO_CONNECT_PEOPLE.videoUrl}?utm_source=lifecycle&utm_medium=email&utm_campaign=connect_people`;

// spec-453 email; spec-487 t-5 adds the how-to video (clickable poster + fallback)
// immediately before the "Join the Discord" CTA. Copy + subject are UNCHANGED.
export function buildConnectPeopleEmail(
  input: ConnectPeopleEmailInput,
): EmailMessage {
  const greeting = activationGreeting(input.firstName);
  const opener = "However far you've got.";
  const para1 =
    "It's been a little while since you joined Memex AI. Wherever you've got to, agent connected, first spec shipped, or not started yet, that's completely fine. No pressure here.";
  const para2 =
    "When you want a hand, the Discord is the easiest way in. Ask in #help, see how other teams run it, real people answer.";
  const last =
    "This is the last of your onboarding emails, so I'll leave you to it. The door's always open whenever you want to pick things up.";

  const text = renderEmailText({
    intro: [greeting, opener, para1, para2, `Watch it here: ${CONNECT_PEOPLE_VIDEO_URL}`, last],
    url: DISCORD_INVITE_URL,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "Real people, whenever you're stuck.",
    heading: "You've run the loop. Don't run it alone.",
    bodyParagraphs: [
      escapeHtml(greeting),
      `<strong>${escapeHtml(opener)}</strong>`,
      escapeHtml(para1),
      escapeHtml(para2),
      // spec-487 t-5 — how-to video (poster + fallback), sits right before the CTA.
      renderVideoThumbnail({
        videoUrl: CONNECT_PEOPLE_VIDEO_URL,
        thumb1xUrl: EMAIL_HOWTO_CONNECT_PEOPLE.thumb1xUrl,
        thumb2xUrl: EMAIL_HOWTO_CONNECT_PEOPLE.thumb2xUrl,
        alt: "Watch: how to connect with people",
      }),
      renderVideoFallbackLine(CONNECT_PEOPLE_VIDEO_URL),
    ],
    ctaLabel: "Join the Discord",
    ctaUrl: DISCORD_INVITE_URL,
    showPasteLink: false,
    afterCtaParagraphs: [escapeHtml(last), ACTIVATION_SIGNOFF_HTML],
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "You've run the loop. Don't run it alone.",
    text,
    html,
    // spec-453 dec-6: stable comms key — the Day-12 pass dedups on THIS. Unchanged.
    commsType: "activation.connect_people",
    // spec-487 t-5 — Postmark click tracking for the video link's utm attribution.
    trackLinks: true,
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
    closing: `You're getting this because someone requested a sign-in link for Memex.AI with this email. If it wasn't you, you can safely ignore this message — no one can sign in without the link above.`,
  });

  const html = renderEmailHtml({
    preheader: "Single-use sign-in link, expires in 15 minutes.",
    heading: "Sign in to Memex.AI",
    bodyParagraphs: [
      `Your single-use sign-in link. It expires in 15 minutes.`,
    ],
    ctaLabel: "Sign in",
    ctaUrl: input.loginUrl,
    footerNote: `You're getting this because someone requested a sign-in link for Memex.AI with this email. If it wasn't you, you can safely ignore this message — no one can sign in without the link above.`,
  });

  return {
    to: input.to,
    subject: `Your Memex.AI sign-in link`,
    text,
    html,
    // spec-442 ac-1/ac-8: stamp the precise auth comms type so the sign-in link is
    // classified as 'magic_link' in comms_log — the type travels with the template
    // (mirroring email_verification above), else recordEmailComm defaults it to
    // 'transactional', which is reserved for genuine non-auth mail.
    commsType: "magic_link",
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
    // spec-442 ac-1/ac-8: stamp the precise auth comms type so the reset email is
    // classified as 'password_reset' in comms_log — the type travels with the
    // template (mirroring email_verification above), else recordEmailComm defaults
    // it to 'transactional', which is reserved for genuine non-auth mail.
    commsType: "password_reset",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// spec-320 — comment @-mention + assignment (dec-3)
// ──────────────────────────────────────────────────────────────────────────
// Two templates, deliberately distinct copy: a plain MENTION (attention, no
// obligation) and an ASSIGNMENT (mention + ownership). A mention-add sends the
// mention email; an assignment sends the assignment email — never both (the
// assignee, being mention+ownership, gets only the stronger assignment signal).
// Both deep-link to the comment via its `c-N` anchor (?comment=c-N).

export interface MentionEmailInput {
  to: string;
  /** Display name of the person who @-mentioned the recipient. */
  mentionerName: string;
  /** Human label for the Spec/doc the comment lives on, e.g. "spec-320 — Comments…". */
  specLabel: string;
  /** Absolute deep-link to the comment (…/specs/spec-N?comment=c-M). */
  commentUrl: string;
}

export function buildMentionEmail(input: MentionEmailInput): EmailMessage {
  const text = renderEmailText({
    intro: [
      `${input.mentionerName} mentioned you in a comment on ${input.specLabel}.`,
      `Open the comment to see what they'd like your eyes on:`,
    ],
    url: input.commentUrl,
    closing: `You're receiving this because you were @-mentioned in a Memex comment.`,
  });

  const html = renderEmailHtml({
    preheader: `${input.mentionerName} mentioned you in a comment on ${input.specLabel}.`,
    heading: `${escapeHtml(input.mentionerName)} mentioned you`,
    bodyParagraphs: [
      `<strong>${escapeHtml(input.mentionerName)}</strong> mentioned you in a comment on <strong>${escapeHtml(input.specLabel)}</strong>.`,
      `Open the comment to see what they'd like your eyes on.`,
    ],
    ctaLabel: "View comment",
    ctaUrl: input.commentUrl,
    footerNote: `You're receiving this because you were @-mentioned in a Memex comment.`,
  });

  return {
    to: input.to,
    subject: `${input.mentionerName} mentioned you in a comment on ${input.specLabel}`,
    text,
    html,
  };
}

export interface AssignmentEmailInput {
  to: string;
  /** Display name of the person who assigned the comment. */
  assignerName: string;
  /** Human label for the Spec/doc the comment lives on. */
  specLabel: string;
  /** Absolute deep-link to the comment (…/specs/spec-N?comment=c-M). */
  commentUrl: string;
}

export function buildAssignmentEmail(input: AssignmentEmailInput): EmailMessage {
  const text = renderEmailText({
    intro: [
      `${input.assignerName} assigned you a comment to resolve on ${input.specLabel}.`,
      `You own this one — open it, handle it, and resolve the comment when it's done:`,
    ],
    url: input.commentUrl,
    closing: `You're receiving this because a Memex comment was assigned to you.`,
  });

  const html = renderEmailHtml({
    preheader: `${input.assignerName} assigned you a comment to resolve on ${input.specLabel}.`,
    heading: `${escapeHtml(input.assignerName)} assigned you a comment`,
    bodyParagraphs: [
      `<strong>${escapeHtml(input.assignerName)}</strong> assigned you a comment to resolve on <strong>${escapeHtml(input.specLabel)}</strong>.`,
      `You own this one — open it, handle it, and resolve the comment when it's done.`,
    ],
    ctaLabel: "View comment",
    ctaUrl: input.commentUrl,
    footerNote: `You're receiving this because a Memex comment was assigned to you.`,
  });

  return {
    to: input.to,
    subject: `${input.assignerName} assigned you a comment to resolve on ${input.specLabel}`,
    text,
    html,
  };
}
