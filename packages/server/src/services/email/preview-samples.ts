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
  buildVerificationEmail,
  buildMagicLinkEmail,
  buildPasswordResetEmail,
  buildDomainVerificationEmail,
  buildWaitlistConfirmationEmail,
  buildMcpCanonicalRefsSwitchEmail,
  buildMentionEmail,
  buildAssignmentEmail,
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
};

export const EMAIL_TEMPLATE_NAMES: string[] = Object.keys(EMAIL_PREVIEW_SAMPLES);
