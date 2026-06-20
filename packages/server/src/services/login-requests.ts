// Originating-session surrogate for the magic-link flow (spec-304 / embedded webview).
//
// Problem: a Flutter desktop app embeds the live web UI in a webview. The user requests a
// magic link, but clicks it in their EXTERNAL browser (a different cookie jar), so the
// webview that asked for the link never becomes authenticated. A login_requests row is a
// polling handle the originating webview holds (its `id`, a high-entropy capability) and
// polls on; when the link is consumed elsewhere we stamp `verifiedAt`, and the next poll
// hands the originating webview a session in-place — without it ever seeing the raw token.
//
// Security posture mirrors auth_tokens: `id` yields a session, so it is short-lived (TTL
// mirrors the magic_link token) and the status endpoint only returns a session for a row
// that is genuinely verified AND not expired.
//
// silent: login_requests is silent-allowed per std-8 §6 — same family as auth_tokens. The
// originating client polls; there is no SSE subscriber on the surrogate's lifecycle. The
// mutate() wrap is the structural guarantee (Mutated<T> brand + coverage scanner), not an
// SSE-facing event.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { loginRequests, type LoginRequest } from "../db/schema.js";
import { mutate, type Mutated } from "./mutate.js";

export interface CreateLoginRequestInput {
  /** The auth_tokens row this surrogate stands in for. */
  tokenId: string;
  email: string;
  /** Mirror the magic_link token's expiry so the capability dies with the token. */
  expiresAt: Date;
}

// Creates the poll-handle row and returns its id — the high-entropy capability the
// originating client polls on. The raw token is never threaded through here.
export async function createLoginRequest(
  input: CreateLoginRequestInput,
): Promise<Mutated<{ id: string }>> {
  return mutate(
    {},
    { memexId: "", entity: "login_request", action: "created" },
    async () => {
      const [row] = await db
        .insert(loginRequests)
        .values({
          tokenId: input.tokenId,
          email: input.email.trim().toLowerCase(),
          expiresAt: input.expiresAt,
        })
        .returning({ id: loginRequests.id });
      return { id: row.id };
    },
    { silent: true },
  );
}

// Reads the surrogate by its capability id. Returns null for an unknown id so the route
// can 404. No mutation — a plain read.
export async function getLoginRequestStatus(id: string): Promise<LoginRequest | null> {
  if (typeof id !== "string" || !id) return null;
  const row = await db.query.loginRequests.findFirst({
    where: eq(loginRequests.id, id),
  });
  return row ?? null;
}

// Stamps verifiedAt on the (not-yet-verified) surrogate whose tokenId matches. Called from
// the consume path once the magic-link token is consumed in the external browser, so the
// originating client's next poll flips to verified. Idempotent: the isNull guard means a
// second consume (which can't happen — tokens are single-use) is a no-op.
export async function markLoginRequestVerified(
  tokenId: string,
): Promise<Mutated<LoginRequest | null>> {
  return mutate(
    {},
    { memexId: "", entity: "login_request", action: "updated" },
    async () => {
      const [updated] = await db
        .update(loginRequests)
        .set({ verifiedAt: new Date() })
        .where(and(eq(loginRequests.tokenId, tokenId), isNull(loginRequests.verifiedAt)))
        .returning();
      return updated ?? null;
    },
    { silent: true },
  );
}

// Single-shot pickup: removes the surrogate after the originating client has collected its
// session, so the loginRequestId capability yields exactly one session and can't be
// replayed. Returns the deleted row (or null if already gone — a concurrent poll won the
// race), which lets the route stay idempotent under double-polling.
export async function deleteLoginRequest(id: string): Promise<Mutated<LoginRequest | null>> {
  return mutate(
    {},
    { memexId: "", entity: "login_request", action: "deleted" },
    async () => {
      const [deleted] = await db
        .delete(loginRequests)
        .where(eq(loginRequests.id, id))
        .returning();
      return deleted ?? null;
    },
    { silent: true },
  );
}
