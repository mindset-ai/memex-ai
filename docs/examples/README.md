# docs/examples — emitting AC verification events

This page tells you how a test suite reports acceptance-criteria results to
Memex. The guidance topics point readers here to check whether an official
helper exists for their stack, so this is the answer to that question.

## Is there an official helper for my stack?

| stack | status |
|---|---|
| JavaScript / TypeScript + Vitest | **yes** — `@memex-ai-ac/vitest`, published on npm |
| everything else | not yet — hand-roll it, see below |

Nothing in this directory needs to be copied or vendored any more. An earlier
version of this page described a single `ac-emit-vitest.ts` file to paste into
your test setup; that file is gone and the helper is a published package.

## JavaScript / TypeScript

```bash
npm install --save-dev @memex-ai-ac/vitest
```

```typescript
// vitest.config.ts
export default defineConfig({
  test: { setupFiles: ['@memex-ai-ac/vitest/setup'] },
});
```

Then tag a test with the acceptance criterion it proves, using the full
canonical ref:

```typescript
import { tagAc } from '@memex-ai-ac/vitest';

it('refuses an expired token', () => {
  tagAc('mindset-prod/memex-building-itself/specs/spec-3/acs/ac-1');
  // …
});
```

Untagged tests emit nothing. Set `MEMEX_EMIT_KEY` in the environment that runs
the tests, or every emission is rejected `401` and the criterion stays
unverified while your suite passes.

## Any other stack

Hand-roll it — it is a small emitter, and the protocol is specified
language-agnostically:

```
get_information(topic='ac-emission-bootstrap')
```

That topic is the source of truth for the wire format, the routing rules, and
the behavioural contract. Do not reverse-engineer the protocol from this page.

## The shape that matters: batch, don't post per test

Whichever route you take, the emitter buffers results and sends them
**batched** — roughly **one request per test file**, not one request per test.

- `POST <base>/api/test-events/batch` takes `{ "events": [ … ] }`, 1–500 events,
  authenticated once for the whole request. Each event is still authorised
  individually, so a batch cannot write outside the Memex your key covers. The
  response reports per-event outcomes, so a batch can partially succeed.
- `POST <base>/api/test-events` takes a single event. It is the fallback for
  servers with no `/batch` route (an older deploy, or a self-hosted install on a
  prior version), which answer `404`/`405`.

This is not a micro-optimisation. Every request takes a slot in the server's
connection pool, so a suite that posts once per tagged test can starve the
product for everyone using it while CI runs. That has happened in production.

Two rules that follow from it, and that a hand-rolled emitter gets wrong by
default:

- **Fall back on `404`/`405` only.** Any other non-2xx — `400`, `401`, `429`,
  `5xx` — is not a missing route. Treating a `429` as "route absent" fans one
  refused batch out into hundreds of single requests against a server that is
  already shedding load.
- **Never retry.** A failed emission is dropped, and a `429` especially so: it
  means the server is protecting itself. The cost of dropping is that one
  acceptance criterion keeps an older status until the next run — a freshness
  loss, never a broken build. Emission must never be able to break CI.

## History

[`../ac-primitive-hypothesis.md`](../ac-primitive-hypothesis.md) records the
original hypothesis behind the AC primitive, from before the helper was
published. Kept for provenance; this page is the current instruction.
