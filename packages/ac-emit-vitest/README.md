# @memex-ai-ac/vitest

Acceptance Criteria emit helper for [Vitest](https://vitest.dev/). Tag your tests with `tagAc()` and emit pass/fail events to your [Memex](https://memex.ai) workspace.

## Install

```bash
npm install --save-dev @memex-ai-ac/vitest
```

## Wire it up

Add to your `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["@memex-ai-ac/vitest/setup"],
  },
});
```

## Tag your tests

```typescript
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

describe("cache layer", () => {
  it("uses Redis when tokens are available", () => {
    tagAc("<your-namespace>/<your-memex>/specs/spec-3/acs/ac-1");
    expect(cache.backend()).toBe("redis");
  });
});
```

The ref shape is `<namespace>/<memex>/specs/<spec-id>/acs/<ac-id>`. To find the right values, open any spec or AC in your Memex in a browser and copy the URI from the address bar. The `<namespace>` is the routing prefix the helper uses to find your Memex instance; the public production instance at memex.ai uses `mindset-prod`. See [How the helper routes emissions](#how-the-helper-routes-emissions) below for the full table.

On every test run, the helper reads the per-task ACs tagged via `tagAc()` and POSTs a pass/fail event to the Memex `/api/test-events` endpoint derived from the ref's namespace. Untagged tests emit nothing.

## Authentication: `MEMEX_EMIT_KEY`

`/api/test-events` requires a per-Memex emission key. Generate one in the Memex settings (**Emission Keys**) — it's shown once as `mxk_…` — and set it where your tests run:

```bash
MEMEX_EMIT_KEY=mxk_… npm test
```

The helper attaches it as `Authorization: Bearer <key>` on every POST. In CI, store it as a secret (e.g. a GitHub Actions / GitLab CI secret) named `MEMEX_EMIT_KEY`; the helper picks it up automatically.

A key authorises emissions **only for the Memex it was generated in** (the Memex named by your `ac_uid`s). If `MEMEX_EMIT_KEY` is unset or wrong, the emission is rejected `401` and silently dropped — a warning is logged but **your test run never fails** because of it. So a missing key degrades the verification signal without breaking the build.

## Three controls for adopters

### `MEMEX_EMIT` — gate the emission

When you don't want emissions from a particular environment (typically developer laptops), set:

```bash
MEMEX_EMIT=false npm test
```

The helper makes zero HTTP requests. Accepted off-values (case-insensitive): `false`, `0`, `no`, `off`. Default and any other value is `true`.

### `hidden` — opt a single emission out of the dashboard

When you want the emission recorded for audit but not surfaced in the verification badge (typical case: iterating on a `done`-phase regression fix):

Per-call:

```typescript
tagAc("<your-namespace>/<your-memex>/specs/spec-3/acs/ac-1", { hidden: true });
```

Or globally for one test run:

```bash
MEMEX_HIDDEN=true npm test
```

Hidden emissions are stored server-side (audit trail intact) but the AC's verification badge stays at the latest non-hidden emission.

### `actor` — top-level WHO

Actor is a top-level wire-format field (sibling of `hidden` and `metadata`), not a metadata key. The helper auto-populates from a documented env-var fallback chain:

1. `GITHUB_ACTOR` (GitHub Actions)
2. `GITLAB_USER_LOGIN` (GitLab CI)
3. `BUILDKITE_BUILD_AUTHOR` (BuildKite)
4. `CIRCLE_USERNAME` (CircleCI)
5. `USER` (Unix shell)
6. `USERNAME` (Windows shell)

When no env var in the chain is set, the field is omitted from the payload and the server stores NULL. A hand-rolled `metadata.actor` key (legacy wire format) is accepted opaquely as metadata but is NOT promoted into the canonical actor field server-side.

### `metadata` — extensible context

The helper auto-populates well-known metadata keys when running in CI on GitHub Actions, GitLab CI, BuildKite, or CircleCI:

- `branch` — git branch
- `commit` — commit SHA
- `host` — `ci`
- `run_id` — CI run identifier
- `run_url` — clickable link to the CI run

You can add your own keys per emission:

```typescript
tagAc("<your-namespace>/<your-memex>/specs/spec-3/acs/ac-1", {
  metadata: { tenant: "acme", feature_flag: "rag_v2" },
});
```

Or globally via env vars:

```bash
MEMEX_METADATA_tenant=acme MEMEX_METADATA_feature_flag=rag_v2 npm test
```

Size limits: ~4KB total metadata, 32 keys maximum, 256 chars per value. The server validates; if an emission exceeds limits, the offending keys are dropped, the verification signal still lands, and an `X-Memex-Warning` response header names what was dropped.

**Important**: metadata is visible to anyone who can read the Memex, including anonymous visitors on public Memexes. Do not put sensitive values here.

## How the helper routes emissions

The AC ref's namespace IS the routing instruction:

- `mindset-int/...` → `https://int.memex.ai`
- `mindset-prod/...` → `https://memex.ai`

For other namespaces, set `MEMEX_TEST_EVENTS_URL` explicitly. The default routing is the safety mechanism that stops production-tagged events from leaking elsewhere.

## Maintainers: why `exports` has a `development` condition

`dist/` is gitignored and only (re)built by `prepare`/build, but Node loads the
package via `default` → `dist/`. Inside this monorepo a `git pull` of `src`
therefore left workspace consumers running a **stale `dist/`** until they
reinstalled — the cause of the spec-129/issue-1 silent `401`s, where an old
keyless `dist` dropped the `MEMEX_EMIT_KEY` → `Authorization: Bearer` transport.

The fix: the package `exports` declare a `development` condition pointing at TS
source, which vitest/Vite select, so workspace consumers always run live `src/`
and can never hit a stale `dist`. The condition is **repo-only** —
`publishConfig.exports` strips it at publish time so the npm tarball (which ships
no `src/`) stays `dist`-only and unaffected. Do not remove the `development`
condition or the `publishConfig` override; `src/package-resolution.test.ts`
(spec-129 ac-23) locks both in place.

## Requirements

- Node.js 20 or later (uses native `fetch`)
- Vitest 2.0 or later

## License

Released under the **Sustainable Use Licence** — the same licence that covers the rest of [memex-app](https://github.com/mindset-ai/memex-app). Full text in [`LICENSE.md`](./LICENSE.md).

In plain terms: you may use, copy, modify, and distribute this helper for your own internal business purposes or for non-commercial / personal use, free of charge. You may not redistribute it commercially or build a paid product on top of it. See `LICENSE.md` for the precise terms.

Source files containing `.ee.` in the filename or under a `.ee` directory (if any are ever added to this package) fall under the separate Memex Enterprise Licence (`LICENSE_EE.md` in the main repository).
