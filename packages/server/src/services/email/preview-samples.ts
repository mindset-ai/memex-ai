// spec-226 t-5 — sample inputs for every transactional email, in ONE place.
//
// Both the dev preview route (routes/__dev__.ts) and the send-test script
// (scripts/send-test-email.ts) build their EmailMessage from this registry, so a
// new template is registered once and is immediately previewable AND send-testable.
//
// These are SAMPLE values for visual inspection only — never wired into a real
// send. URLs derive from APP_BASE_URL so a preview reflects the env it runs in
// (local → http://localhost:5173, int → int.memex.ai), matching the env-derived
// links the real emails use.

import type { EmailMessage } from "./sender.js";
import {
  buildWelcomeEmail,
  buildVerificationEmail,
  buildMagicLinkEmail,
  buildPasswordResetEmail,
  buildDomainVerificationEmail,
  buildWaitlistConfirmationEmail,
  buildMcpCanonicalRefsSwitchEmail,
  buildMentionEmail,
  buildAssignmentEmail,
  buildConnectedInactiveEmail,
  buildSignedInDormantEmail,
  buildWinbackEmail,
  buildVerifiedMilestoneEmail,
  buildConnectPeopleEmail,
} from "./templates.js";

const BASE = process.env.APP_BASE_URL ?? "https://memex.ai";
const sampleUrl = (path: string): string => `${BASE}${path}`;
const SAMPLE_TOKEN = "SAMPLE_TOKEN_a1b2c3d4e5f6";

/**
 * Template name → builder invoked with sample inputs and the chosen recipient.
 * Add a new email here when its builder lands (welcome, the two spec-427 emails),
 * and it is instantly reachable from both the preview route and the send-test script.
 */
export const EMAIL_PREVIEW_SAMPLES: Record<string, (to: string) => EmailMessage> = {
  welcome: (to) => buildWelcomeEmail({ to, appUrl: BASE, firstName: "Sample" }),
  verification: (to) =>
    buildVerificationEmail({ to, verifyUrl: sampleUrl(`/verify-email?token=${SAMPLE_TOKEN}`) }),
  "magic-link": (to) =>
    buildMagicLinkEmail({ to, loginUrl: sampleUrl(`/auth/magic?token=${SAMPLE_TOKEN}`) }),
  "password-reset": (to) =>
    buildPasswordResetEmail({ to, resetUrl: sampleUrl(`/reset-password?token=${SAMPLE_TOKEN}`) }),
  "domain-verification": (to) =>
    buildDomainVerificationEmail({
      to,
      orgName: "Sample Org",
      domain: "example.com",
      verifyUrl: sampleUrl(`/verify-domain?token=${SAMPLE_TOKEN}`),
    }),
  waitlist: (to) =>
    buildWaitlistConfirmationEmail({ to, name: "Sample", company: "Sample Org" }),
  "mcp-canonical-refs": (to) =>
    buildMcpCanonicalRefsSwitchEmail({ to, tokensUrl: sampleUrl("/settings/tokens") }),
  mention: (to) =>
    buildMentionEmail({
      to,
      mentionerName: "Sample Reviewer",
      specLabel: "spec-1 — Sample Spec",
      commentUrl: sampleUrl("/mindset-prod/sample/specs/spec-1?comment=c-1"),
    }),
  assignment: (to) =>
    buildAssignmentEmail({
      to,
      assignerName: "Sample Reviewer",
      specLabel: "spec-1 — Sample Spec",
      commentUrl: sampleUrl("/mindset-prod/sample/specs/spec-1?comment=c-1"),
    }),
  // spec-427 t-2 — the two activation/win-back emails. Preview keys are hyphenated
  // (like `magic-link`); the comms_log keys are the dotted `activation.*` — keep
  // the two namespaces distinct. App deep-links derive from APP_BASE_URL (dec-8).
  "activation-connected-inactive": (to) =>
    buildConnectedInactiveEmail({
      to,
      firstName: "Sample",
      createSpecUrl: sampleUrl("/mindset-prod/sample/specs/new"),
      memexUrl: sampleUrl("/mindset-prod/sample"),
    }),
  "activation-signed-in-dormant": (to) =>
    buildSignedInDormantEmail({ to, firstName: "Sample", appUrl: BASE }),
  // spec-480 — the win-back email (video thumbnail + "Connect your agent"). This is what
  // the signed_in_dormant cohort actually receives in v1 (activation.winback); the
  // signed-in-dormant sample above is retained as the superseded spec-427 template.
  // Registered here so the win-back render (its one intentional image) is previewable +
  // send-testable on int for visual QA (ac-1).
  "activation-winback": (to) =>
    buildWinbackEmail({ to, firstName: "Sample", connectUrl: "https://www.memex.ai/download?src=winback-email" }),
  // spec-453 — "See it verified" (verified-milestone) + "Connect with people".
  // Same hyphenated preview-key convention as the spec-427 pair above; the
  // comms_log keys stay the dotted `activation.verified_milestone` /
  // `activation.connect_people`. Registered here so both are previewable and
  // send-testable on int (spec-453/issue-1).
  "activation-verified-milestone": (to) =>
    buildVerifiedMilestoneEmail({ to, firstName: "Sample", appUrl: BASE }),
  "activation-connect-people": (to) =>
    buildConnectPeopleEmail({ to, firstName: "Sample" }),
};

export const EMAIL_TEMPLATE_NAMES: string[] = Object.keys(EMAIL_PREVIEW_SAMPLES);
