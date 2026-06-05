import { Hono } from "hono";
import { OAuth2Client } from "google-auth-library";
import {
  getSharedDocumentByToken,
  createExternalComment,
  ShareTokenError,
} from "../services/share-tokens.js";
import { getUserByEmail, listMemberships } from "../services/users.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { readJsonBody, requireString } from "./validation.js";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const oauthClient = googleClientId ? new OAuth2Client(googleClientId) : null;
const DEV_USER_EMAIL = "dev@memex.ai";

// PUBLIC share endpoints (t-10 + t-11). No tenant or session middleware applied — guests
// access shared documents by possession of the token alone. Comment POST requires a Bearer
// token (authenticated user) but NOT account membership in the doc's tenant — the token
// is the read permission, the Bearer auth provides the commenter's identity.
//
// Important: this router is registered in app.ts BEFORE sessionMiddleware is attached to
// the resource routes. memexResolver (global) still runs, but the share route doesn't
// care about currentAccount — the token resolves to the doc regardless of which subdomain
// the request arrived on.
const shareRouter = new Hono();

// GET /api/share/:token — returns the doc + sections + account branding info + comments
shareRouter.get("/:token", async (c) => {
  const token = c.req.param("token");
  try {
    const payload = await getSharedDocumentByToken(token);
    return c.json(payload);
  } catch (err) {
    if (err instanceof ShareTokenError) {
      const status = err.reason === "revoked" ? 410 : 404;
      return c.json({ error: err.message, reason: err.reason }, status);
    }
    throw err;
  }
});

// Resolve a Bearer ID token to a Memex user + their namespace. Unlike sessionMiddleware
// this doesn't require the user to be a member of the tenant the request is addressed to —
// the share token itself is the access grant. Used ONLY for external commenting.
//
// `namespaceId` here is the AUTHOR's namespace id — `createExternalComment`
// writes it into doc_comments.author_namespace_id so the External badge renders
// correctly when author_namespace_id != memex.namespace_id.
async function resolveAuthorizedCommenter(
  authHeader: string | undefined
): Promise<{ userId: string; namespaceId: string; email: string; name: string }> {
  if (!oauthClient) {
    // Dev fallback mirrors sessionMiddleware: any request counts as dev@memex.ai.
    const user = await getUserByEmail(DEV_USER_EMAIL);
    if (!user) throw new ValidationError("Dev user not provisioned");
    if (!user.namespaceId) {
      throw new ValidationError("Your namespace isn't provisioned yet — sign in to the app once first.");
    }
    return {
      userId: user.id,
      namespaceId: user.namespaceId,
      email: user.email,
      name: user.email,
    };
  }

  if (!authHeader?.startsWith("Bearer ")) {
    throw new ValidationError("Sign in to comment");
  }
  const idToken = authHeader.slice(7);
  let email: string;
  let name: string;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: googleClientId!,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new ValidationError("Invalid token payload");
    if (payload.email_verified === false) {
      throw new ValidationError("Email not verified with identity provider");
    }
    email = payload.email;
    name = payload.name ?? email;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Invalid or expired token");
  }

  const user = await getUserByEmail(email);
  if (!user) {
    throw new ValidationError("Sign up first — no Memex account found for this email");
  }
  if (!user.namespaceId) {
    throw new ValidationError("Your namespace isn't provisioned yet — sign in to the app once first.");
  }
  return {
    userId: user.id,
    namespaceId: user.namespaceId,
    email,
    name,
  };
}

// POST /api/share/:token/comments — external user leaves a comment on the shared doc.
// Body: { target: { kind: 'section'|'decision'|'task', id: UUID }, content: string }
// Requires Bearer token (the external user must have a Memex account).
shareRouter.post("/:token/comments", async (c) => {
  const token = c.req.param("token");
  const body = await readJsonBody<{ target?: unknown; content?: unknown }>(c);
  const target = body?.target as { kind?: unknown; id?: unknown } | undefined;
  const content = requireString(body?.content, "content", { trim: true });

  if (
    !target ||
    typeof target !== "object" ||
    typeof target.id !== "string" ||
    typeof target.kind !== "string" ||
    !["section", "decision", "task"].includes(target.kind)
  ) {
    return c.json(
      { error: "target must be { kind: 'section'|'decision'|'task', id: UUID }" },
      400
    );
  }
  const targetKind = target.kind as "section" | "decision" | "task";

  try {
    const commenter = await resolveAuthorizedCommenter(c.req.header("Authorization"));
    const comment = await createExternalComment(
      {
        token,
        authorUserId: commenter.userId,
        authorNamespaceId: commenter.namespaceId,
        authorName: commenter.name,
        target: { kind: targetKind, id: target.id },
        content,
      },
      { channel: "rest_ui" },
    );
    return c.json(comment, 201);
  } catch (err) {
    if (err instanceof ShareTokenError) {
      const status = err.reason === "revoked" ? 410 : 404;
      return c.json({ error: err.message, reason: err.reason }, status);
    }
    if (err instanceof NotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 401);
    }
    throw err;
  }
});

export { shareRouter };
