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
  heading: string;
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
  parts.push(input.closing, "Memex.AI");
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
        `<div style="font-family:${FONT_STACK};font-size:15px;font-weight:700;color:${BRAND_CORAL};">${escapeHtml(s.label)}</div>` +
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
        `<a href="${escapeHtml(r.url)}" style="color:${BRAND_INK};font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(r.title)}</a>` +
        `<div style="margin-top:2px;color:${BRAND_MUTED};font-size:13px;line-height:1.5;">${escapeHtml(r.description)}</div>` +
        `</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">${rows}</table>`;
}

function renderEmailHtml(input: RenderInput): string {
  const paragraphs = input.bodyParagraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;color:${BRAND_INK};font-size:16px;line-height:1.6;">${p}</p>`,
    )
    .join("");

  const safeUrl = escapeHtml(input.ctaUrl);
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
              <td style="padding:32px 40px;">
                <div style="margin:0 0 20px;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND_INK};">Memex<span style="font-weight:500;color:${BRAND_INK};">.AI</span></div>
                <h1 style="margin:0 0 16px;color:${BRAND_INK};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;">${escapeHtml(input.heading)}</h1>
                ${paragraphs}
                ${stepsHtml}
                <div style="margin:24px 0 8px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:${BRAND_INK};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${escapeHtml(input.ctaLabel)}</a>
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

// spec-428 — the day-one welcome (Option 3). Renders through the shared renderer
// using the step + resources primitives (spec-226 dec-2). Transactional stream,
// always sends; logged under the stable `welcome` key (dec-7). The CTA + resource
// blocks are table/inline-CSS constructs (no imagery) per the Postmark constraints.
export function buildWelcomeEmail(input: WelcomeEmailInput): EmailMessage {
  const firstName = input.firstName?.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  // spec-451 ac-5 — sign-off on two lines ("Best," / name). Two forms: \n for the
  // plain-text body, <br> for the HTML (afterCtaParagraphs is inserted un-escaped).
  const senderName = input.senderName?.trim() || "The Memex AI team";
  const signOffText = `Best,\n${senderName}`;
  const signOffHtml = `Best,<br>${escapeHtml(senderName)}`;

  const value =
    "Your agents are about to start building from what you actually decided, not what they guessed. Every decision is captured as you go, so nothing important gets buried in a chat thread or quietly chosen for you mid-build. And done means verified, not just claimed. No more vibe coding.";
  const afterCtaText =
    "We'll send you a few short emails over the next couple of weeks, and there are some resources below to get you started. If you get stuck, just reply here or find us in #help on Discord.";

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

  const resources: EmailResource[] = [
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

  const text = renderEmailText({
    intro: [
      greeting,
      "Welcome to Memex AI.",
      value,
      "Two steps to get there.",
      "// Step 1 — Connect to the Memex MCP: The app shows you exactly how to connect, whatever coding agent you're using.",
      "// Step 2 — Create your first Spec: Bring an idea and we'll help you shape it, start to finish.",
      afterCtaText,
      "Resources: Understanding Memex AI (https://www.memex.ai/understanding-memex.pdf), Documentation (https://www.memex.ai/docs), Community (Discord).",
    ],
    url: input.appUrl,
    closing: signOffText,
  });

  const html = renderEmailHtml({
    preheader: "Welcome to Memex AI — two steps to your first Spec.",
    heading: "Build what you decided. Not what your agent guessed.",
    bodyParagraphs: [
      escapeHtml(greeting),
      "Welcome to Memex AI.",
      escapeHtml(value),
      "<strong>Two steps to get there.</strong>",
    ],
    steps,
    ctaLabel: "Open Memex AI",
    ctaUrl: input.appUrl,
    showPasteLink: false,
    afterCtaParagraphs: [escapeHtml(afterCtaText), signOffHtml],
    resources,
    footerNote: "You're getting this because you signed up for Memex AI, built by Mindset AI.",
  });

  return {
    to: input.to,
    subject: "Build what you decided. Not what your agent guessed.",
    text,
    html,
    commsType: "welcome",
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
export function buildConnectedInactiveEmail(
  input: ConnectedInactiveEmailInput,
): EmailMessage {
  const greeting = activationGreeting(input.firstName);
  const afterCta1 =
    "Memex will work with your agent to structure the work, and comes back with a Spec and the decisions it needs you to resolve. That's the moment it clicks.";
  const afterCta2 = "Memex does not touch your code.";
  const stuck = "If you get stuck, just reply here or find us in #help on Discord.";

  const text = renderEmailText({
    intro: [
      greeting,
      "Your Memex MCP is connected. The hard part is done.",
      "The next step is to create your first Spec. Bring an idea and we'll help you shape it, start to finish. Not sure where to start? Click the button below and we'll guide you through step by step.",
      afterCta1,
      afterCta2,
      `Watch your Spec come to life in your Memex: ${input.memexUrl}`,
      stuck,
    ],
    url: input.createSpecUrl,
    closing: ACTIVATION_SIGNOFF_TEXT,
  });

  const html = renderEmailHtml({
    preheader: "Your Memex MCP is connected — create your first Spec.",
    heading: "Your Memex MCP is connected. The hard part is done.",
    bodyParagraphs: [
      escapeHtml(greeting),
      "The next step is to create your first Spec. Bring an idea and we'll help you shape it, start to finish. Not sure where to start? Click the button below and we'll guide you through step by step.",
    ],
    ctaLabel: "Create a spec",
    ctaUrl: input.createSpecUrl,
    showPasteLink: false,
    afterCtaParagraphs: [
      escapeHtml(afterCta1),
      escapeHtml(afterCta2),
      `Watch your Spec come to life in <a href="${escapeHtml(input.memexUrl)}" style="color:${BRAND_SKY};">your Memex</a>.`,
      escapeHtml(stuck),
      ACTIVATION_SIGNOFF_HTML,
    ],
    resources: ACTIVATION_RESOURCES,
    footerNote: ACTIVATION_FOOTER,
  });

  return {
    to: input.to,
    subject: "Memex is connected. Here's what to do next.",
    text,
    html,
    // spec-427 ac-14 / dec-7: stable comms key — Slice B's dedup + two-per-cohort
    // cap count this key in comms_log, never the subject line.
    commsType: "activation.connected_inactive",
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
    afterCtaParagraphs: [escapeHtml(afterCtaText), ACTIVATION_SIGNOFF_HTML],
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
