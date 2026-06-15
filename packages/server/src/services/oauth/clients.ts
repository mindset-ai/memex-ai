// OAuth 2.1 Dynamic Client Registration (RFC 7591) — b-31 dec-7(a).
//
// Anonymous registration: any caller can POST /oauth/register with client
// metadata and receive a client_id (and optionally a client_secret). Required
// by MCP spec + Anthropic directory review. Public clients (PKCE-only) omit
// the secret.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { oauthClients, type OAuthClient } from "../../db/schema.js";
import { ValidationError } from "../../types/errors.js";
import { mutate } from "../mutate.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

// Schemes never permitted as a redirect_uri target — they can execute script in
// our origin (javascript:), carry local-file/inline payloads (data/vbscript/
// file/blob/filesystem), or invoke known-abusable OS handlers (ms-msdt: was the
// Follina CVE-2022-30190 vector; intent: targets arbitrary Android components).
// They're denied even though they're non-http(s). Everything else that isn't
// http(s) is treated as an RFC 8252 §7.1 private-use URI scheme (cursor://,
// vscode://, windsurf://, com.example.app:/…). This denylist is defence-in-depth,
// NOT the primary control: the real guards are the browser's external-app prompt,
// the on-origin consent screen, and mandatory PKCE S256 (codes.ts) — the RFC 8252
// §8.6 control that makes custom-scheme redirects safe. spec-253 dec-1 / t-3.
const DANGEROUS_REDIRECT_SCHEMES = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "filesystem",
  "intent",
  "ms-msdt",
]);

/** RFC 7591 metadata accepted at /oauth/register. */
export interface RegisterClientInput {
  /** Required. URLs the IdP will redirect to after consent. */
  redirectUris: string[];
  /** Required. Human-readable client name shown on the consent screen. */
  clientName: string;
  /** Optional metadata (RFC 7591 §2). */
  softwareId?: string;
  softwareVersion?: string;
  /**
   * Token endpoint auth method per RFC 7591 §2. We only accept the two MCP
   * spec calls for explicitly: `none` (public client, PKCE-only) or
   * `client_secret_basic` (confidential client). Default: client_secret_basic.
   */
  tokenEndpointAuthMethod?: "none" | "client_secret_basic";
}

/** RFC 7591 registration response. The secret is one-shot. */
export interface RegisteredClient {
  clientId: string;
  /** Present only for confidential clients. */
  clientSecret?: string;
  /** RFC 7592 — lets the client later read/update its own registration. */
  registrationAccessToken: string;
}

export async function registerClient(input: RegisterClientInput): Promise<RegisteredClient> {
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw new ValidationError("redirect_uris must be a non-empty array");
  }
  // Hard cap — without it a single client row could carry an arbitrarily large
  // array (RFC 7591 doesn't bound it). 10 is well above any legitimate need
  // (Claude Desktop + claude.ai + dev/staging variants ≤ 5).
  if (input.redirectUris.length > 10) {
    throw new ValidationError("redirect_uris exceeds maximum of 10");
  }
  for (const uri of input.redirectUris) {
    if (typeof uri !== "string" || uri.length === 0) {
      throw new ValidationError("redirect_uris entries must be non-empty strings");
    }
    // RFC 7591 §2: redirect_uris MUST be absolute URIs. Disallow URL fragments
    // per RFC 6749 §3.1.2.
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ValidationError(`redirect_uri must be an absolute URI: ${uri}`);
    }
    if (parsed.hash !== "") {
      throw new ValidationError(`redirect_uri must not contain a fragment: ${uri}`);
    }
    // RFC 8252 native-app redirects, three accepted shapes (spec-253 dec-1):
    //   1. https:// (any host)
    //   2. http://{localhost,127.0.0.1} — loopback flow, §7.3 (Claude Desktop)
    //   3. a private-use URI scheme — §7.1 (cursor://, vscode://, windsurf://, …)
    // Bare http:// to a non-loopback host and the dangerous-scheme denylist stay
    // rejected. PKCE S256 (codes.ts) is the safety control for shape 3.
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    const scheme = parsed.protocol.replace(/:$/, "");
    const isWebScheme = scheme === "http" || scheme === "https";
    const accepted =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isLoopback) ||
      (!isWebScheme && !DANGEROUS_REDIRECT_SCHEMES.has(scheme));
    if (!accepted) {
      throw new ValidationError(
        `redirect_uri must be https://, http://localhost, or a private-use URI scheme: ${uri}`,
      );
    }
  }
  if (typeof input.clientName !== "string" || input.clientName.trim().length === 0) {
    throw new ValidationError("client_name must be a non-empty string");
  }

  const method = input.tokenEndpointAuthMethod ?? "client_secret_basic";
  if (method !== "none" && method !== "client_secret_basic") {
    throw new ValidationError(
      "token_endpoint_auth_method must be 'none' or 'client_secret_basic'",
    );
  }

  const clientId = randomToken(16); // 22-char base64url
  const clientSecret = method === "client_secret_basic" ? randomToken(32) : undefined;
  const registrationAccessToken = randomToken(32);

  // silent: OAuth dynamic client registration is anonymous, cross-tenant
  // infrastructure (no memexId, no userId at registration time) — silent-allowed
  // per std-8 §6, no SSE subscriber on the client registry. The wrap preserves the
  // Mutated brand + coverage scanner (spec-156 ac-18).
  await mutate(
    {},
    { memexId: "", entity: "oauth_client", action: "created" },
    async () => {
      await db.insert(oauthClients).values({
        clientId,
        clientSecretHash: clientSecret ? sha256Hex(clientSecret) : null,
        clientName: input.clientName.trim(),
        redirectUris: input.redirectUris,
        registrationAccessTokenHash: sha256Hex(registrationAccessToken),
        softwareId: input.softwareId ?? null,
        softwareVersion: input.softwareVersion ?? null,
      });
    },
    { silent: true },
  );

  return { clientId, clientSecret, registrationAccessToken };
}

/** Look up a client by its public client_id. Returns null if missing or revoked. */
export async function getClientByClientId(clientId: string): Promise<OAuthClient | null> {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.revokedAt)));
  return row ?? null;
}

/**
 * Verify the client_secret presented at the /oauth/token endpoint. Timing-safe
 * comparison of SHA-256 hashes. Returns false if the client is public (no
 * secret on file) or the secret doesn't match.
 */
export function verifyClientSecret(client: OAuthClient, providedSecret: string): boolean {
  if (!client.clientSecretHash) return false;
  const provided = sha256Hex(providedSecret);
  const stored = client.clientSecretHash;
  if (provided.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
}

/** Check whether a client is public (PKCE-only, no client_secret). */
export function isPublicClient(client: OAuthClient): boolean {
  return client.clientSecretHash === null;
}

/** Revoke a client by row id. Soft-delete — row stays for audit. */
export async function revokeClient(id: string): Promise<void> {
  // silent: same posture as registerClient — cross-tenant OAuth client registry,
  // no memexId, silent-allowed per std-8 §6 (spec-156 ac-18).
  await mutate(
    {},
    { memexId: "", entity: "oauth_client", action: "deleted" },
    async () => {
      await db
        .update(oauthClients)
        .set({ revokedAt: new Date() })
        .where(eq(oauthClients.id, id));
    },
    { silent: true },
  );
}
