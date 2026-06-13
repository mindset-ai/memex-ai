// Single source of truth: the server's Drizzle schema.
//
// This package exists so an out-of-workspace repo (Backstage, the operator
// control plane — spec-280) can consume the production DB schema with full
// types WITHOUT forking `schema.ts` or depending on the monorepo. We do NOT
// copy the schema here; we re-export it and let the build (tsup/esbuild) bundle
// the schema source — and inline the few type-only cross-file imports it makes
// (`CommentAction`, `CommentAudience`) — into a self-contained dist with zero
// `workspace:*` / `@memex/*` dependencies. The only runtime dep that survives
// is `drizzle-orm` itself, which the consumer uses directly anyway.
//
// spec-279 dec-1: published to private GitHub Packages as `@mindset-ai/db-schema`.
export * from "../../server/src/db/schema.js";
