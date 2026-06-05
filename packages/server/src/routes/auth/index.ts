// Composes the four auth sub-routers into the single `auth` Hono app that app.ts mounts
// at /api/auth. Sub-routers split by flow:
//   - sso          → /sso/google
//   - password     → /signup, /login, /verify-email, /resend-verification
//   - magicLink    → /magic-link, /magic-link/consume
//   - reset        → /password-reset, /password-reset/confirm
//   - session      → /me, /profile, /switch-account
//
// Adding a new auth flow → new file under routes/auth/ + one .route() call here.

import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { sso } from "./sso.js";
import { password } from "./password.js";
import { magicLink } from "./magic-link.js";
import { reset } from "./reset.js";
import { session } from "./session.js";
import { slack } from "./.ee/slack.js";

export const auth = new Hono<MemexResolverEnv & SessionEnv>();

auth.route("/sso", sso);
auth.route("/", password); // signup, login, verify-email, resend-verification
auth.route("/magic-link", magicLink);
auth.route("/password-reset", reset);
auth.route("/", session); // me, profile, switch-account
auth.route("/slack", slack); // Slack OAuth — connect, callback, disconnect
