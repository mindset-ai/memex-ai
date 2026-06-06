// Load .env as early as possible so downstream module-load code sees the vars.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { app, injectWebSocket } from "./app.js";
import { cleanupExpiredDomainVerificationTokens } from "./services/domain-verification.js";
import { warnIfLlmNotConfigured } from "./agent/anthropic-client.js";
import { startBusObservability } from "./services/bus-observability.js";
import { startActivityLogSink } from "./services/activity-log.js";
import { startActivityLogSweep } from "./services/activity-log-sweep.js";
import { startScaffoldAdditionsCacheInvalidation } from "./services/scaffold-additions-cache.js";
import { startBusRelay } from "./services/bus-relay.js";
import { bus } from "./services/bus.js";
import { sqlClient } from "./db/connection.js";

// Re-export database layer for use by other packages
export { db } from "./db/connection.js";
export { documents, docSections } from "./db/schema.js";
export type { Doc, DocSection } from "./db/schema.js";

// Re-export app for testing
export { app } from "./app.js";

const port = parseInt(process.env.PORT ?? "8080", 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server listening on http://localhost:${info.port}`);
  warnIfLlmNotConfigured();
  // doc-16 dec-3: passive observability for write-vs-emit divergence. The
  // timer is .unref()'d so it doesn't keep the process alive during shutdown.
  startBusObservability()?.unref();
  // b-60 t-3: the activity_log sink — one bus subscriber that persists every
  // interaction for Pulse. Advisory: insert failures are swallowed, writes are
  // detached from the emit path.
  startActivityLogSink();
  // b-68 t-11: short-TTL projection cache for per-Org scaffold additions, with
  // bus-driven invalidation so admin edits become visible without a process
  // restart. Single subscriber filtered on `org_scaffold_addition`.
  startScaffoldAdditionsCacheInvalidation();
  // spec-156 W1: cross-instance change-bus relay (Postgres LISTEN/NOTIFY). Lets
  // an event emitted on one Cloud Run instance reach SSE subscribers pinned to
  // another (--max-instances 3, no session affinity). Initial LISTEN failure is
  // non-fatal — start() routes it into capped-backoff reconnect and the NOTIFY
  // write path works regardless, so the server still boots if LISTEN is down.
  startBusRelay({ bus, pooledSql: sqlClient }).catch((err) => {
    console.error("[bus-relay] failed to start (server continues; reconnect loop active):", err);
  });
});

// spec-190 t-1 / dec-9: attach the WebSocket upgrade handler to the live server
// so the voice route (/api/<ns>/<mx>/voice/session) can accept WS connections.
// Must run after serve() returns the Node http.Server.
injectWebSocket(server);

// Hourly cleanup of expired domain-verification tokens (t-6).
//
// NOTE: invite tokens are intentionally NOT purged on a schedule anymore — see
// the comment in services/invite-tokens.ts. Deleting expired invite rows made
// an expired link look "invalid" instead of "expired"; rows are now retained so
// consumeInviteToken can still report reason:"expired".
const ONE_HOUR_MS = 60 * 60 * 1000;
setInterval(async () => {
  try {
    const deleted = await cleanupExpiredDomainVerificationTokens();
    if (deleted > 0) {
      console.log(`[domain-verification-cleanup] deleted ${deleted} expired token(s)`);
    }
  } catch (err) {
    console.error("[domain-verification-cleanup] failed:", err);
  }
}, ONE_HOUR_MS).unref();

// b-60 t-8: hourly activity_log retention sweep (PULSE_RETENTION_DAYS, default 30).
// Bounded (10k rows/pass), idempotent across instances; self-scheduling hourly. The
// timer is .unref()'d so it never blocks shutdown.
startActivityLogSweep().unref();
