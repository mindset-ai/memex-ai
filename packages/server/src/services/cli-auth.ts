// Device-flow state for the MCP installer CLI. Three lifecycle states:
//
//   pending   — CLI just called /start; waiting for user to confirm in the browser.
//   completed — User clicked Authorize; minted_token is set, waiting for CLI to poll.
//   consumed  — CLI polled and received the token; minted_token wiped immediately.
//
// Rows TTL out after CLI_AUTH_REQUEST_TTL_MS regardless of state. Cleanup runs lazily
// inside lookup/poll so we don't need a cron.

import { eq, lt, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { db } from "../db/connection.js";
import { cliAuthRequests, type CliAuthRequest } from "../db/schema.js";
import { mintMcpToken } from "./mcp-tokens.js";
import { mutate, type Mutated } from "./mutate.js";

export const CLI_AUTH_REQUEST_TTL_MS = 5 * 60 * 1000;
export const CLI_AUTH_POLL_TIMEOUT_MS = 30 * 1000;
export const CLI_AUTH_POLL_INTERVAL_MS = 1000;

// Human-friendly device codes: 4-4 alphanumeric in unambiguous-letters set (no 0/O/I/1).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

// silent: cli_auth_requests is silent-allowed per std-8 §6 — ephemeral 5-min
// device-flow state, no UI subscriber. The wrap keeps the type brand structural.
async function purgeExpired(): Promise<void> {
  await mutate(
    {},
    { memexId: "", entity: "cli_auth_request", action: "deleted" },
    async () => {
      await db.delete(cliAuthRequests).where(lt(cliAuthRequests.expiresAt, new Date()));
    },
    { silent: true },
  );
}

// Called by the CLI to claim a code. Returns the code (which the user types/clicks in
// the browser) and the reqId (which the CLI uses to poll).
//
// silent: cli_auth_requests is silent-allowed per std-8 §6.
export async function startCliAuthRequest(): Promise<Mutated<{ reqId: string; code: string }>> {
  await purgeExpired();
  return mutate(
    {},
    { memexId: "", entity: "cli_auth_request", action: "created" },
    async () => {
      // Retry on the unlikely collision (~1 in 1M)
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        try {
          const [row] = await db
            .insert(cliAuthRequests)
            .values({
              code,
              expiresAt: new Date(Date.now() + CLI_AUTH_REQUEST_TTL_MS),
            })
            .returning();
          return { reqId: row.id, code: row.code };
        } catch (err) {
          // Unique violation on `code` — try again
          if (attempt === 4) throw err;
        }
      }
      throw new Error("Failed to allocate cli_auth_request code");
    },
    { silent: true },
  );
}

// Looks up by code. Used by the admin's confirm page (sessionMiddleware-protected) to
// verify the code is real before showing the Authorize button. Returns null when not
// found / expired / already consumed (the admin shouldn't show Authorize then).
export async function lookupCliAuthRequest(code: string): Promise<CliAuthRequest | null> {
  await purgeExpired();
  const row = await db.query.cliAuthRequests.findFirst({
    where: eq(cliAuthRequests.code, code),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// Called by the admin's Authorize button (after user confirms). Mints a fresh
// mcp_tokens row for the logged-in user with the given device label, then attaches the
// raw token to the request row so the CLI poll can pick it up.
//
// Idempotent: completing an already-completed request is a no-op (returns the existing
// row). Already-consumed requests throw (CLI got the token; can't mint twice).
export async function completeCliAuthRequest(
  code: string,
  userId: string,
  label: string
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "expired" | "already_consumed" }> {
  await purgeExpired();
  const row = await db.query.cliAuthRequests.findFirst({
    where: eq(cliAuthRequests.code, code),
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (row.status === "consumed") return { ok: false, reason: "already_consumed" };
  // If already completed, return ok — re-confirming the same code is fine; the CLI
  // poll will pick up whichever token landed first.
  if (row.status === "completed") return { ok: true };

  const { raw } = await mintMcpToken(userId, label);
  // silent: cli_auth_requests is silent-allowed per std-8 §6. mcp_token.created
  // already emitted above via mintMcpToken; this update is a sibling state-machine
  // transition with no SSE consumer.
  await mutate(
    {},
    { memexId: "", userId, entity: "cli_auth_request", action: "updated" },
    async () => {
      await db
        .update(cliAuthRequests)
        .set({ status: "completed", mintedToken: raw, completedAt: sql`now()` })
        .where(eq(cliAuthRequests.id, row.id));
    },
    { silent: true },
  );

  return { ok: true };
}

// Single-shot poll: returns the token if the request has been completed (and clears it
// from the row in the same transaction so the CLI sees it exactly once). The CLI is
// expected to wrap this in a longer-poll loop with the configured interval/timeout.
export async function pollCliAuthRequest(
  reqId: string
): Promise<
  | { status: "pending" }
  | { status: "completed"; token: string }
  | { status: "expired" }
  | { status: "not_found" }
> {
  const row = await db.query.cliAuthRequests.findFirst({
    where: eq(cliAuthRequests.id, reqId),
  });
  if (!row) return { status: "not_found" };
  if (row.expiresAt.getTime() < Date.now()) return { status: "expired" };
  if (row.status === "pending") return { status: "pending" };
  if (row.status === "consumed") {
    // Shouldn't happen in normal flow — the CLI gets the token once and stops polling.
    // Treat as not_found rather than leaking that a token existed.
    return { status: "not_found" };
  }
  // status === "completed"
  const token = row.mintedToken;
  if (!token) return { status: "not_found" };

  // Atomic consume: only the first poll wins.
  // silent: cli_auth_requests is silent-allowed per std-8 §6.
  const consumed = await mutate(
    {},
    { memexId: "", entity: "cli_auth_request", action: "updated" },
    async () => {
      const [row] = await db
        .update(cliAuthRequests)
        .set({ status: "consumed", mintedToken: null })
        .where(
          sql`${cliAuthRequests.id} = ${reqId} AND ${cliAuthRequests.status} = 'completed'`
        )
        .returning();
      return row;
    },
    { silent: true },
  );
  if (!consumed) {
    // Lost the race — another poll consumed it. Return not_found rather than the token.
    return { status: "not_found" };
  }
  return { status: "completed", token };
}
