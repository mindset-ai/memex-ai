// spec-354 sol-2: this file is now a BARREL.
//
// The former ~2,866-line all-domains API monolith has been carved into
// per-domain modules under `packages/ui/src/api/` (docs, search, comments,
// decisions, tasks, issues, auth, org, memex, mcp, drift, integrations, oauth,
// acs, insights, billing). This barrel re-exports every prior symbol so the
// ~185 existing `from "../api/client"` imports keep resolving unchanged — same
// names, same signatures, same return types. No behaviour change.
//
// The carve mirrors the existing per-domain sibling files (home.ts, journey.ts,
// scaffold.ts, whatsNew.ts) and keeps the shared HTTP/error/fetchJson infra in
// http.ts / errors.ts / fetchJson.ts (audit spec-345 finding sol-2; umbrella
// spec-354).

// ── Shared infrastructure (unchanged — re-exported for back-compat) ──────────
export {
  ApiError,
  NotFoundError,
  AuthApiError,
  OrgApiError,
  MemberApiError,
  ShareAccessError,
} from './errors';
export { fetchJson } from './fetchJson';
export { fetchWithRetry, authHeaders } from './http';

// spec-136: re-export the Tag wire type so call sites can pull it from the
// client alongside the tag functions below.
export type { Tag } from './types';
// spec-158: re-export the Memex-level issue wire type alongside the
// fetchMemexIssues helper the Issues page consumes.
export type { MemexIssue } from './types';
// doc-19: re-export the namespace-home + memex DTOs (previously surfaced here).
export type { NamespaceHomeResponse, MemexDto } from './types';

// spec-171 billing tenant type (was a local export of this module).
export type { OrgTenant } from './internal';

// ── Per-domain modules ───────────────────────────────────────────────────────
export * from './docs';
export * from './search';
export * from './comments';
export * from './decisions';
export * from './tasks';
export * from './issues';
export * from './auth';
export * from './org';
export * from './memex';
export * from './mcp';
export * from './drift';
export * from './integrations';
export * from './oauth';
export * from './acs';
export * from './insights';
export * from './billing';
