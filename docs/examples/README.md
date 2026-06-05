# docs/examples

Reference implementations that exercise the Memex MCP surface. Each file is
intended to be copied or vendored into a consumer codebase as-is for the
V0.0.1 spike, and to become the seed for a published npm / pypi package once
the AC primitive is stable.

## `ac-emit-vitest.ts`

The hook-based AC emission helper for Vitest. Provides `tagAc(acUid)` as
a one-line opt-in per test, with global `beforeEach` / `afterEach` hooks
that POST `(ac_uid, status, test_identifier, duration_ms)` to the Memex
`/api/test-events` endpoint after every tagged test.

Companion to [`../ac-primitive-hypothesis.md`](../ac-primitive-hypothesis.md).
Verified at scale against a large external test suite (3,875 tests, 4 tagged,
4 emissions landed cleanly).

### Usage

1. Copy this file into your test setup directory.
2. Side-effect import it from your Vitest setup file:
   ```typescript
   import './ac-emit-vitest';
   ```
3. Add the setup file to `vitest.config.ts` if you don't already:
   ```typescript
   test: { setupFiles: ['./tests/setup.ts'] }
   ```
4. Opt tests in by calling `tagAc('dev/ns/mx/briefs/b-N/ac-M')` from inside
   the test body.

Untagged tests emit nothing.

### Why a file, not a package (yet)

V0.0.1. Publishing as `@memex/ac-vitest` makes sense once: (a) the wire
format is stable, (b) we have a second framework (Jest, pytest, ...)
exercising the same shape, and (c) we know whether the per-test-tag model
vs the reporter-plugin model is the right ergonomic. See the next-steps
discussion in the hypothesis doc.
