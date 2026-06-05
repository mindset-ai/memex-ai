# Migration runbook — b-105: Brief → Spec rename

The product noun changed from **Brief** to **Spec** (per std-19). This was a hard rename
across the MCP tool surface, the URL grammar, the database `doc_type`, the CLI, and the
Standards. There is **no compatibility shim** for the renamed MCP tools — old tool names
return a JSON-RPC "tool not found". Old URLs are preserved via permanent (301) redirects.

This runbook is the operator-facing companion to the `## 3.0.0` entry in
[`CHANGELOG.md`](../../CHANGELOG.md). It exists so anyone upgrading a running
deployment (or an MCP client) knows exactly what breaks and what to do.

## What changed

| Surface | Before | After | Compatibility |
|---|---|---|---|
| MCP tools | `assess_brief`, `publish_brief` | `assess_spec`, `publish_spec` | **None** — old names error (hard rename, no alias) |
| URL paths | `/<ns>/<mx>/briefs/b-N` | `/<ns>/<mx>/specs/spec-N` | **301 Permanent Redirect** (all 5 path shapes: base, doc, `/decisions`, `/tasks`, `/comments`) |
| Handles | `b-N` | `spec-N` | Old `b-N` paths redirect; handles themselves are reissued as `spec-N` |
| Database | `documents.doc_type = 'brief'` | `documents.doc_type = 'spec'` | Migrated in place by `packages/server/drizzle/0065_brief_to_spec.sql` |
| CLI | `memex-ai` 2.x | `memex-ai` 3.0.0 | Major bump signals the MCP tool-name change to installers |
| Standards | — | std-19 added; std-1, std-10, std-15 amended | Documentation only |

## Operator steps (per environment)

1. **Deploy the server first.** The schema migration `0065_brief_to_spec.sql` runs as part
   of `packages/server/deploy.sh` (migrations precede the Cloud Run cutover). It rewrites
   every `doc_type='brief'` row to `'spec'` in place — additive/idempotent, no backfill job.
2. **Deploy the admin (React UI).** It reads the `spec`-typed payloads and routes on the
   `/specs/...` grammar.
3. **Smoke** (`make smoke-<env>`): confirm `/specs/...` resolves and a known legacy
   `/briefs/b-N` URL returns 301 → `/specs/spec-N`.
4. **Notify MCP-client users** to upgrade `memex-ai` to 3.0.0 — pinned-2.x clients calling
   `assess_brief` / `publish_brief` will get "tool not found" until they update.

## Verification

- `documents` has **zero** `doc_type IN ('brief','mission','strategy')` rows.
- MCP registry exposes `assess_spec` + `publish_spec`; the `*_brief` names are **not**
  registered (not even as aliases).
- `rewriteBriefPathToSpec` returns a 301 for each legacy path shape and `null` for an
  already-`spec`-shaped path.
- Repo is free of `\b(brief|mission|strategy)\b` outside
  [`.legacy-spec-vocab-allowlist.txt`](../../.legacy-spec-vocab-allowlist.txt) (which
  carries the deliberate historical-lineage exceptions: drizzle migration history, this
  runbook, the CHANGELOG, and the immutable historical docs).

(These invariants are guarded by `packages/server/src/__regression__/b105-ac-coverage.regression.test.ts`
and `no-legacy-spec-vocab.regression.test.ts`.)

## Rollback

The schema change is the only stateful step. `0065_brief_to_spec.sql` is a value rewrite
(`doc_type 'brief' → 'spec'`), not a structural change, so a rollback is a reverse value
update plus redeploying the prior server/admin images. The 301 redirect layer is pure code
(`services/redirects.ts`) and reverts with the image. Prefer rolling **forward** — the
rename is complete and the legacy vocabulary is gone from the active surface.
