# Feature Hiding Runbook (`HIDDEN_FEATURES`)

How to hide/unhide soft-launched features per environment — and, more importantly,
**where the value actually lives** so a change sticks instead of being reverted by
the next deploy.

> **TL;DR — to durably change what's hidden on an environment, edit the
> `HIDDEN_FEATURES` line in the GCP Secret Manager secret `memex-<env>-deploy-env`.**
> That secret is what CI reads on every deploy. Editing the live Cloud Run env var,
> or a local `scripts/deploy.<env>.env`, will *not* survive the next
> merge-to-`main`/`develop` deploy. See
> [Where the value actually lives](#where-the-value-actually-lives).

> **⚠ This runbook said the opposite until 2026-08-15.** It named the GitHub Actions
> secret `DEPLOY_ENV_FILE` as the authoritative store and called the GCP secret
> "effectively a red herring". That was true when written and became false with
> spec-518 t-6 (PRs #589 / #599), which pointed CI at the canonical secret and then
> removed the step that wrote the blob. `DEPLOY_ENV_FILE` has since been deleted from
> the GitHub environments. **Do not follow an older copy of this page** — its step 3
> would recreate a secret that nothing reads.

## What `HIDDEN_FEATURES` does

The server reads `HIDDEN_FEATURES` at runtime via `getHiddenFeatures()`
([`packages/server/src/services/auth.ts`](../packages/server/src/services/auth.ts)),
puts the parsed slug list on the session payload (`/api/auth/me`), and the React
UI drops the matching nav links + routes via
[`packages/ui/src/utils/featureFlags.ts`](../packages/ui/src/utils/featureFlags.ts).
It's a server-side env var — no SPA/admin-bundle rebuild is needed, it's picked up
on the next server deploy.

## Slugs in play

| Slug         | Hides                           |
|--------------|---------------------------------|
| `scaffold`   | Scaffold inspector              |
| `spec-pause` | Spec pause/resume controls      |
| `pulse`      | Pulse activity board            |
| `home`       | Home tab (nav link + `/` route) |

The value is a comma-separated slug list, e.g. `HIDDEN_FEATURES="spec-pause,home"`.

## Where the value actually lives

There are **two** places the value can appear (a third exists only on a developer's
machine), and for a normal CI deploy **only one governs**:

| # | Store | Read by | Authoritative for |
|---|-------|---------|-------------------|
| 1 | **GCP Secret Manager secret `memex-<env>-deploy-env`** — holds the entire per-env config body | `scripts/deploy-config.sh`, because the `deploy` CI job ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) sets `DEPLOY_CONFIG_SOURCE: secret` | **Every CI deploy** (merge to `main` → prod, `develop` → int). **This is the one that matters.** |
| 2 | Live Cloud Run env var on `memex-api` | The running container | The current revision *only*. Overwritten by the next CI deploy. |
| 3 | Local `scripts/deploy.<env>.env` | `deploy-config.sh`, **only** when `DEPLOY_CONFIG_SOURCE` is unset *and* the file exists | An ad-hoc local/break-glass deploy from a laptop. **Never present in CI** — the step that used to write it was removed (spec-518 t-6). Gitignored. |

### Why (1) wins in CI

`deploy-config.sh` resolves its config source like this:

- `DEPLOY_CONFIG_SOURCE=secret` → fetch GCP Secret Manager `memex-<env>-deploy-env` **← what CI sets**
- `DEPLOY_CONFIG_SOURCE=local` → use `scripts/deploy.<env>.env`
- unset → if `scripts/deploy.<env>.env` is present use it, otherwise fetch the GCP secret

CI pins the source explicitly:

```yaml
DEPLOY_CONFIG_SOURCE: secret
DEPLOY_CONFIG_PROJECT: memex-ai-${{ github.ref_name == 'main' && 'prod' || 'int' }}
```

and writes no local file at all, so the local-override branch is unreachable from CI.
Then [`packages/server/deploy.sh`](../packages/server/deploy.sh) injects the value with
`gcloud run deploy --update-env-vars HIDDEN_FEATURES=<value>`.

**Confirm it per deploy, don't assume it.** Every deploy log prints its resolved source:

```
[deploy-config] source=SECRET-MANAGER secret=memex-prod-deploy-env project=memex-ai-prod
```

`source=LOCAL-OVERRIDE` in a CI log would mean the pinning has regressed — that exact
silent bypass is what spec-518 t-6 was created to fix, and it ran unnoticed for weeks.

### Why editing (2) or (3) doesn't stick

- **(2) Live Cloud Run env var** — a manual
  `gcloud run services update ... --update-env-vars=HIDDEN_FEATURES=...` changes
  the serving revision immediately, but the next CI deploy re-asserts the value from
  the canonical secret and overwrites it. (This is the "I bumped it and it reverted" loop.)
- **(3) Local `scripts/deploy.<env>.env`** — exists only on your machine, is gitignored,
  and is never created in CI. Editing it changes your own break-glass deploys and nothing else.

## Deploy-time semantics: unset ≠ empty

`--update-env-vars` is a **merge**, and `deploy.sh` only includes
`HIDDEN_FEATURES` in that merge when the sourced config **explicitly set** it
(`${HIDDEN_FEATURES+...}`):

- **Set to a value** (`HIDDEN_FEATURES="spec-pause,home"`) → that value is written.
- **Set to empty** (`HIDDEN_FEATURES=""`) → a deliberate "un-hide everything"; written as empty.
- **Unset** (line absent/commented) → **omitted** from the merge; whatever is
  already live is left untouched. Deleting the line does **not** un-hide — it
  freezes the current state. (This guard stops a deploy from a checkout that
  never set the value from silently un-hiding features.)

Runtime is **fail-open**: an unset/empty `HIDDEN_FEATURES` on the running server
makes `getHiddenFeatures()` return `[]` → nothing hidden.

> The same set-vs-unset rule governs every optional per-env key, and for a key a
> **child process** must read — as opposed to `deploy.sh`'s own shell — the key also
> needs an explicit `export` guard in `deploy-config.sh`. A plain assignment is visible
> to `deploy.sh` and invisible to anything it spawns; that gap cost a refused prod deploy
> on 2026-08-14 (spec-518, `DB_POOL_MAX`).

## Durably change what's hidden (the procedure that sticks)

Unlike a GitHub Actions secret, the GCP secret **can be read back** — so this is a
read-modify-write on one store, with no mirror to keep in sync:

```bash
ENV=prod                              # or int
PROJECT=memex-ai-${ENV}
NEW_VALUE="spec-pause"                # the desired full slug list
TMP=$(mktemp)

# 1. Pull the current body, flipping ONE line.
gcloud secrets versions access latest --secret="memex-${ENV}-deploy-env" --project="$PROJECT" \
  | sed -E "s/^(export[[:space:]]+)?HIDDEN_FEATURES=.*/HIDDEN_FEATURES=\"${NEW_VALUE}\"/" \
  > "$TMP"

# 2. Sanity-check the line you changed AND that nothing else moved.
grep HIDDEN_FEATURES "$TMP"
diff <(gcloud secrets versions access latest --secret="memex-${ENV}-deploy-env" --project="$PROJECT") "$TMP"

# 3. Push the new version.
gcloud secrets versions add "memex-${ENV}-deploy-env" --project="$PROJECT" --data-file="$TMP"

# 4. Read it back from GCP — verify the write rather than trusting it.
gcloud secrets versions access latest --secret="memex-${ENV}-deploy-env" --project="$PROJECT" \
  | grep HIDDEN_FEATURES

rm "$TMP"                             # the body holds DB coordinates
```

The `diff` in step 2 is not ceremony: `sed` over a whole config body is one bad regex
away from dropping a line, and a key silently absent from the next deploy is a live
configuration change (spec-518's whole subject). One line should differ.

The change takes effect on the **next deploy** of that env (merge to `main`/`develop`,
or a manual "Deploy" workflow_dispatch). To also flip the *currently live* revision
without waiting for a deploy, additionally run the manual update below — but the
durable fix above is what makes it last.

## Flip the live revision immediately (does NOT persist on its own)

```bash
gcloud run services update memex-api --region=us-east4 --project=memex-ai-<env> \
  --update-env-vars=HIDDEN_FEATURES=spec-pause
```

Use this only for an instant change; pair it with the durable procedure above or
the next CI deploy will revert it.

## Check the current state

```bash
# What the live prod service is serving right now:
gcloud run services describe memex-api --project=memex-ai-prod --region=us-east4 \
  --format="value(spec.template.spec.containers[0].env)" | tr ';' '\n' | grep HIDDEN_FEATURES

# What the NEXT deploy will apply (readable, unlike the old GitHub secret):
gcloud secrets versions access latest --secret=memex-prod-deploy-env --project=memex-ai-prod \
  | grep HIDDEN_FEATURES
```

Those two commands answering differently is the normal state between a durable edit
and the deploy that applies it — and if they disagree *after* a deploy, the deploy
did not read what you think it read. Check the `[deploy-config] source=` line in its log.
