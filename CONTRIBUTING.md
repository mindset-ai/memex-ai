# Contributing to Memex

Thanks for being here. Memex is fair-code, source-available, and built in public — contributions are welcome, and a few things will make yours land smoothly.

This guide is opinionated about *how* work happens here. Read the [philosophy](#philosophy) section before you sink time into a large change.

## TL;DR

- **Trivial fixes** (typos, docs, obvious bugs): just open a PR. Sign-off (`git commit -s`) required.
- **Non-trivial changes** (features, refactors, behaviour changes): open an issue or draft a **Spec** in Memex first. Code without a Spec gets bounced.
- **EE features** (anything under `.ee.` / `.ee/`): coordinate with Mindset first — these require a CLA.
- **Standards drift** (anything that contradicts an `std-N`): say so in the PR and reference the Standard. Don't paper over it.

If in doubt, open an issue and ask before you write code.

## Philosophy

Memex is built using the philosophy it advocates: **Spec-Driven Development**. The full pitch lives in [`SDD.md`](SDD.md); the short version:

- The durable unit of work is a **Spec** — a living document that records purpose, decisions, acceptance criteria, and tasks.
- Decisions (`dec-N`), acceptance criteria, and tasks (`t-N`) are typed primitives — not prose in a PR description.
- Standards (`std-N`) are durable, cross-cutting rules. They apply across Specs and are load-bearing.
- The phases are `draft → plan → build → verify → done`. Code lands in `build`, gets verified in `verify`, freezes in `done`.

You don't need to be a Memex user to contribute — but a non-trivial PR will be evaluated against the Standards and current Specs, so it pays to know where they live.

## Before you start

### Search the knowledge map

For anything beyond a typo or obvious bug, search Memex's public knowledge map first. Your change probably touches a Standard or has prior context in an existing Spec:

- Production app + Specs: [memex.ai/mindset-prod/memex-building-itself](https://memex.ai/mindset-prod/memex-building-itself)
- The Standards index lives in [`CLAUDE.md`](CLAUDE.md) (look for `std-1` … `std-24`).

If you're using an AI agent to help write the contribution, [install the Memex MCP](README.md#quick-install-recommended) and let it `search_memex` for relevant prior work.

### Open an issue first

For anything more than a trivial fix, open an issue describing:

- **What** you want to change and **why**.
- **Which Standards or Specs** you've already found that touch this area.
- **Whether you've already discussed it** with a maintainer (Slack / email / GitHub Discussions).

We may ask you to draft a Spec in Memex before any code is written — that's how features get planned here. It feels like overhead for the first contribution; it pays off by the third.

## Local setup

Full instructions live in [`README.md`](README.md#getting-started). The short version:

```bash
brew install postgresql@16
brew services start postgresql@16
pnpm install
cp packages/server/.env.example packages/server/.env  # add ANTHROPIC_API_KEY
pnpm --filter @memex/server db:migrate
make dev   # API at :8080, React UI at :5173
```

Docker / OrbStack alternative also covered in the README.

## What kind of contribution is this?

The expectations branch by contribution type.

### Bug fix

1. **Write a failing test first.** Standard practice here — see [`CLAUDE.md`](CLAUDE.md) "Test-First Bug Fixing." This applies to every bug fix without exception.
2. **Verify the test fails** without your fix.
3. **Apply the fix.**
4. **Verify the test passes.**
5. **Run the relevant tier** (`make test-unit`, `make test-integration`, etc — see [`README.md`](README.md#testing) for the test tier table).

PR description should link the failing test and the fix in separate commits when reasonable.

### New feature

1. **Open an issue or draft a Spec in Memex.** Either is fine for the first conversation.
2. **Get sign-off on the approach** before writing code. Drive any open questions to **decisions** in the Spec — don't bake unresolved trade-offs into a PR.
3. **Move the Spec to `build` phase only when decisions are resolved.** That's where code lands.
4. **Tick acceptance criteria as each task verifies** against running behaviour.
5. **PR description references the Spec handle** (`spec-N`) and lists which decisions and ACs it closes.

### Documentation / typo

1. Just open the PR. Sign-off required, but no Spec needed.
2. If you're changing user-facing vocabulary, note the [naming conventions](CLAUDE.md) — "Spec" / "Standard" in user-facing prose, generic `doc-N` / `std-N` handles in code, URLs, and DB.

### EE feature (`.ee.` / `.ee/`)

EE files are governed by [`LICENSE_EE.md`](LICENSE_EE.md), not the Sustainable Use License. Contributing to EE code requires:

1. **Coordination with Mindset first** — email [support@mindset.ai](mailto:support@mindset.ai). Don't open an EE PR cold.
2. **A signed Contributor License Agreement (CLA)** granting Mindset the rights needed to distribute the contribution under both LICENSE.md and LICENSE_EE.md. We'll send the CLA after first contact.
3. **The same Spec-driven workflow** as a non-EE feature — EE work is planned in a Memex Spec like everything else.

Why the extra step: EE files are commercially gated, and we can't accept patches we don't have the right to distribute under both licenses. The CLA fixes that once for every future contribution.

## Standards you'll bump into

These come up often — read them before you touch related code:

- **[`std-8`](CLAUDE.md)** — every tenancy-scoped mutation flows through `mutate()` in `services/mutate.ts`. No direct DB writes that skip the unified bus. Composite writes emit one event per logical change.
- **[`std-7`](CLAUDE.md)** — unauthorized resource access returns 404, not 403. No enumeration leak.
- **[`std-10`](CLAUDE.md)** — canonical URL `ref` grammar. Don't invent new path shapes.
- **[`std-14`](CLAUDE.md)** — debug logging goes to `packages/server/.logs/<domain>.log`, not stdout.
- **[`std-15`](CLAUDE.md)** — agent prompts live in `packages/server/src/agent/phases/` markdown, never inline in code.
- **[`std-17`](README.md#smoke-testing-policy-std-17--spec-70)** — every change ships with smoke tests; deploy gates on a green smoke.

If your change contradicts a Standard, **say so in the PR** and either (a) update the Standard with reasoning or (b) explain why this Spec is the exception. Silent drift is the failure mode the system is built to prevent — don't be the contributor who introduces it.

## Code & test standards

### Style

- TypeScript everywhere. `strict: true`. No new `any`.
- Match the style of the surrounding file — naming, comment density, error-handling shape.
- No new top-level npm dependencies without justification. The repo has a strong [zero-dependency bias](CLAUDE.md) — built-ins and hand-rolled over SaaS.

### Tests

The test tier table is in [`README.md`](README.md#testing). Rule of thumb for which tier to add to:

| Change touches… | Add a test in… |
|---|---|
| Pure function / formatter / route handler logic | Unit (`*.test.ts`) |
| Service hitting Postgres | Integration (`*.integration.test.ts`) |
| HTTP surface + SSE propagation | API / E2E (`*.api.test.ts`) |
| Auth, tenancy, isolation, injection | Security (`src/__security__/`) |
| Architectural rule (e.g. "every mutation goes through `mutate()`") | Regression (`src/__regression__/*.regression.test.ts`) |
| New deployed surface | Smoke (`src/__smoke__/*.smoke.test.ts`) |

If you're not sure which tier, ask in the PR — we'd rather have a test in the wrong place than a missing test.

### What we won't merge

- Code without tests when tests would be reasonable.
- Mutations that bypass `mutate()` (std-8 violation).
- New deps that could be a built-in or a small hand-roll.
- Inline agent prompt strings (std-15).
- Changes to `.ee.` files without a signed CLA.
- PRs that contradict a Standard without acknowledging it.

## Submitting a PR

### Branch + commits

- Branch from `develop` — the integration line all work lands on first (`main` is the release line; see [Branches](README.md#branches)). Name it descriptively: `fix/auth-token-expiry`, `feat/spec-readiness-rubric`, `docs/contributing-guide`.
- **Sign your commits** with the Developer Certificate of Origin (DCO):

  ```bash
  git commit -s -m "fix: token refresh races with sweep job"
  ```

  The `-s` flag adds `Signed-off-by: Your Name <you@example.com>`. This certifies you wrote the code (or have the right to submit it) under the project's license. PRs without sign-off will be asked to amend.

- Conventional-commit prefixes are encouraged but not required: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

### PR description

Include:

- **What changed** and **why**.
- **Spec / decision references** if non-trivial: `Closes ac-3 of spec-47. Implements dec-2.`
- **Standards touched** if any: `Adds std-8 coverage for invite-tokens (was bypass per spec-21).`
- **Test tier(s) added**.
- **Smoke**: if the change touches a deployed surface, list the smoke probe added or extended.

### Review & merge

- A maintainer reviews. We may request changes against the Standards or Spec rubric — that's normal, not a slight.
- Mergers are Mindset team members. Community contributors can self-merge typo / doc PRs once a maintainer approves; substantive changes are merged by the team after CI + smoke.
- We squash-merge by default. Your sign-off is preserved.

## Reporting bugs

- Search existing issues first.
- For security issues, **do not open a public issue.** Email [support@mindset.ai](mailto:support@mindset.ai) — we'll respond within 2 business days.
- For functional bugs, include:
  - What you did
  - What you expected
  - What actually happened
  - Browser / OS / Node version where relevant
  - Steps to reproduce — ideally a minimal Spec / repo / curl

## Getting help

- **Open a [GitHub Discussion](https://github.com/mindset-ai/memex-ai/discussions)** for questions, ideas, and "should I…" conversations.
- **Email [support@mindset.ai](mailto:support@mindset.ai)** for partnership, EE, or licensing questions.
- **Don't DM individual maintainers** with support questions — Discussions keep answers searchable for the next person.

## Code of conduct

Be the kind of contributor you'd want to receive a PR from. Critique the code, not the person. Disagree by writing — issue, comment, decision in a Spec — not by re-litigating in DMs.

This project follows the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/). Conduct issues: email [support@mindset.ai](mailto:support@mindset.ai).

## Thank you

Genuinely. Open contribution is a gift, especially to a fair-code project where you know commercial features exist alongside the open core. We don't take it lightly.
