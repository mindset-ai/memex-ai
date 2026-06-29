// spec-226 t-5 — one-shot: render a transactional email with sample data and send
// it to an address of your choice, so you can check the real Gmail/Outlook render.
//
// Usage:
//   # List available templates:
//   pnpm --filter @memex/server tsx scripts/send-test-email.ts --list
//
//   # Send one to your inbox (uses getEmailSender — Postmark if configured, else
//   # ConsoleEmailSender prints it):
//   pnpm --filter @memex/server tsx scripts/send-test-email.ts --template welcome --to you@example.com
//
// Env notes:
//   * No POSTMARK_SERVER_TOKEN/EMAIL_FROM → ConsoleEmailSender prints the body (no delivery).
//   * For int, use the Postmark TEST token (POSTMARK_API_TEST) so it accepts but never delivers
//     and never touches sender reputation (spec-427 dec-8). Use a real token only to reach your
//     own test inboxes.
//   * Sample links derive from APP_BASE_URL — set it to match the env you want the links to point at.

import { getEmailSender } from "../src/services/email/sender.js";
import {
  EMAIL_PREVIEW_SAMPLES,
  EMAIL_TEMPLATE_NAMES,
} from "../src/services/email/preview-samples.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  // Also accept the space form: --template welcome
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    console.log("Available templates:");
    for (const t of EMAIL_TEMPLATE_NAMES) console.log(`  ${t}`);
    process.exit(0);
  }

  const template = arg("template");
  const to = arg("to");

  if (!template || !to) {
    console.error("Usage: --template <name> --to <address>   (or --list)");
    console.error(`Templates: ${EMAIL_TEMPLATE_NAMES.join(", ")}`);
    process.exit(1);
  }

  const build = EMAIL_PREVIEW_SAMPLES[template];
  if (!build) {
    console.error(`Unknown template '${template}'. Known: ${EMAIL_TEMPLATE_NAMES.join(", ")}`);
    process.exit(1);
  }

  const message = build(to);
  console.log(`[send-test] template=${template} to=${to} subject="${message.subject}"`);

  try {
    await getEmailSender().send(message);
    console.log(`  ✓ handed to the email sender`);
    process.exit(0);
  } catch (err) {
    console.error(`  ✗ send failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[send-test] fatal:", err);
  process.exit(1);
});
