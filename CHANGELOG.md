# Changelog

All notable changes to this project are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 3.0.0 - TBD

### Breaking changes

- **MCP tools renamed:** `assess_brief` → `assess_spec`, `publish_brief` → `publish_spec`. Old names return JSON-RPC "tool not found".
- **URL paths migrated:** `/<ns>/<mx>/briefs/b-N` → `/<ns>/<mx>/specs/spec-N`. Old URLs return HTTP 301 Permanent Redirect.
- **`memex-ai` CLI bumped to 3.0.0** to reflect the MCP tool-name change.
- **Schema:** `documents.doc_type='brief'` rows migrated to `doc_type='spec'` by `packages/server/drizzle/0065_brief_to_spec.sql`.
- **Standards:** std-19 added ("Specs are spec-driven development's canonical artifact"). std-1, std-10, std-15 amended.

See the operator runbook for upgrade/rollback steps and verification: [`docs/migrations/b-105-brief-to-spec.md`](docs/migrations/b-105-brief-to-spec.md).
