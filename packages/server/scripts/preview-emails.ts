import { writeFileSync, mkdirSync } from "node:fs";
import {
  buildVerificationEmail,
  buildMagicLinkEmail,
  buildPasswordResetEmail,
  buildDomainVerificationEmail,
  buildWaitlistConfirmationEmail,
} from "../src/services/email/templates.js";

const dir = "/tmp/memex-email-preview";
mkdirSync(dir, { recursive: true });

const samples = [
  [
    "verification",
    buildVerificationEmail({
      to: "alex@example.com",
      verifyUrl: "https://memex.ai/verify-email?token=abc123xyz",
    }),
  ],
  [
    "magic-link",
    buildMagicLinkEmail({
      to: "alex@example.com",
      loginUrl: "https://memex.ai/magic-link?token=abc123xyz",
    }),
  ],
  [
    "password-reset",
    buildPasswordResetEmail({
      to: "alex@example.com",
      resetUrl: "https://memex.ai/reset-password?token=abc123xyz",
    }),
  ],
  [
    "domain-verification",
    buildDomainVerificationEmail({
      to: "admin@acme.com",
      accountName: "Acme Corp",
      domain: "acme.com",
      verifyUrl: "https://memex.ai/verify-domain/abc123xyz",
    }),
  ],
  [
    "waitlist-with-company",
    buildWaitlistConfirmationEmail({
      to: "alex@acme.com",
      name: "Alex",
      company: "Acme Corp",
    }),
  ],
  [
    "waitlist-no-company",
    buildWaitlistConfirmationEmail({
      to: "alex@example.com",
      name: "Alex",
    }),
  ],
] as const;

for (const [name, msg] of samples) {
  writeFileSync(`${dir}/${name}.html`, msg.html ?? "");
  console.log(`${name}: ${msg.subject}`);
}

const index =
  "<ul style=\"font:16px system-ui;padding:40px;\">" +
  samples
    .map(([n, m]) => `<li><a href="${n}.html">${n}</a> — ${m.subject}</li>`)
    .join("") +
  "</ul>";
writeFileSync(`${dir}/index.html`, index);

console.log(`\nOpen: file://${dir}/index.html`);
