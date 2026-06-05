// b-36 — one-shot notifier: emails every active MCP token holder about the
// canonical-refs hard switch. Built but NOT auto-run; the operator pulls the
// trigger manually after the post-deploy smoke check passes.
//
// Usage:
//   # Default: dry-run, prints distinct recipients and exits.
//   pnpm --filter @memex/server tsx scripts/notify-mcp-canonical-refs.ts
//
//   # Actually send (requires explicit flag, hits getEmailSender()):
//   pnpm --filter @memex/server tsx scripts/notify-mcp-canonical-refs.ts --execute
//
//   # Custom tokens URL (defaults to https://memex.ai/settings/tokens):
//   pnpm --filter @memex/server tsx scripts/notify-mcp-canonical-refs.ts \
//     --tokens-url=https://int.memex.ai/settings/tokens
//
// Why a one-shot script (not a route or migration): a) one-time send,
// b) operator-grade — burns API quota and reaches real users, c) idempotent
// because we de-dupe by user email and rely on Postmark to suppress repeat
// sends within the API window. Each invocation prints a per-recipient
// outcome so a partial failure can be re-run against the unaffected slice.
//
// Selection: distinct user ids with at least one non-revoked row in
// `mcp_tokens`, joined to `users.email`. A user with multiple active tokens
// across devices gets exactly one email.

import { and, isNull, eq } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { mcpTokens, users } from "../src/db/schema.js";
import { getEmailSender } from "../src/services/email/sender.js";
import { buildMcpCanonicalRefsSwitchEmail } from "../src/services/email/templates.js";

interface Recipient {
  userId: string;
  email: string;
}

async function listRecipients(): Promise<Recipient[]> {
  // Distinct user ids with non-revoked tokens, joined to users.email.
  // Drizzle's `.groupBy()` on the email + userId pair gives us one row per
  // user even if they have multiple active token rows.
  const rows = await db
    .selectDistinct({ userId: users.id, email: users.email })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(and(isNull(mcpTokens.revokedAt), eq(users.status, "active")));

  return rows.map((r) => ({ userId: r.userId, email: r.email }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const dryRun = !execute || args.includes("--dry-run");
  const tokensUrlArg = args.find((a) => a.startsWith("--tokens-url="));
  const tokensUrl = tokensUrlArg
    ? tokensUrlArg.slice("--tokens-url=".length)
    : "https://memex.ai/settings/tokens";

  const recipients = await listRecipients();
  console.log(
    `[b-36 notify] mode=${dryRun ? "dry-run" : "execute"} recipients=${recipients.length} tokens-url=${tokensUrl}`,
  );

  if (recipients.length === 0) {
    console.log("Nothing to do — no users with active MCP tokens.");
    process.exit(0);
  }

  if (dryRun) {
    for (const r of recipients) {
      console.log(`  would send to ${r.email} (user=${r.userId})`);
    }
    console.log(
      `\nDry run complete. Re-run with --execute to actually send.`,
    );
    process.exit(0);
  }

  const sender = getEmailSender();
  let sent = 0;
  const failures: Array<{ email: string; reason: string }> = [];

  for (const r of recipients) {
    try {
      await sender.send(
        buildMcpCanonicalRefsSwitchEmail({ to: r.email, tokensUrl }),
      );
      sent += 1;
      console.log(`  ✓ sent to ${r.email}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ email: r.email, reason });
      console.error(`  ✗ failed to send to ${r.email}: ${reason}`);
    }
  }

  console.log(
    `\n[b-36 notify] sent=${sent} failed=${failures.length} of ${recipients.length}`,
  );

  if (failures.length > 0) {
    console.error(
      "Failures (re-run after addressing — script is idempotent on success):",
    );
    for (const f of failures) console.error(`  ${f.email}: ${f.reason}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[b-36 notify] fatal:", err);
  process.exit(1);
});
