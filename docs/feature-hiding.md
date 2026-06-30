# Feature Hiding Runbook (`HIDDEN_FEATURES`)

How to hide/unhide soft-launched features per environment — and, more importantly,
**where the value actually lives** so a change sticks instead of being reverted by
the next deploy.

> **TL;DR — to durably change what's hidden on an environment, edit the
> `HIDDEN_FEATURES` line inside the GitHub Actions environment secret
> `DEPLOY_ENV_FILE` (scoped to the `prod` / `int` environment).** That secret is
> what CI reads on every deploy. Editing the live Cloud Run env var, the local
> `scripts/deploy.<env>.env`, or the GCP `memex-<env>-deploy-env` secret will
> *not* survive the next merge-to-`main`/`develop` deploy. See
> [Where the value actually lives](#where-the-value-actually-lives).

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

This is the part that causes confusion. There are **three** places the value can
appear, but for a normal (CI) deploy **only one governs**:

| # | Store | Read by | Authoritative for |
|---|-------|---------|-------------------|
| 1 | **GitHub Actions environment secret `DEPLOY_ENV_FILE`** (one per env: `prod`, `int`) — holds the entire `deploy.<env>.env` body | The `deploy` CI job ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) writes it to `scripts/deploy.<env>.env`, then `deploy-config.sh` sources it | **Every CI deploy** (merge to `main` → prod, `develop` → int). **This is the one that matters.** |
| 2 | Live Cloud Run env var on `memex-api` | The running container | The current revision *only*. Overwritten by the next CI deploy. |
| 3 | GCP Secret Manager secret `memex-<env>-deploy-env` | `deploy-config.sh` **only when no local `scripts/deploy.<env>.env` exists** | Laptop deploys with no local file. **Not read in CI** — CI always writes the local file from `DEPLOY_ENV_FILE`, which wins. Effectively a red herring for the deploy pipeline. |

### Why (1) wins in CI

`deploy-config.sh` resolves its config source like this:

- `DEPLOY_CONFIG_SOURCE=local` → use `scripts/deploy.<env>.env`
- `DEPLOY_CONFIG_SOURCE=secret` → fetch GCP Secret Manager `memex-<env>-deploy-env`
- **unset (the default)** → if `scripts/deploy.<env>.env` is present, use it; otherwise fetch the GCP secret.

The CI deploy job writes `scripts/deploy.<env>.env` from the `DEPLOY_ENV_FILE`
secret *before* running the deploy, so the local-file branch always wins and the
GCP secret is never consulted. Then
[`packages/server/deploy.sh`](../packages/server/deploy.sh) injects the value with
`gcloud run deploy --update-env-vars HIDDEN_FEATURES=<value>`.

### Why editing (2) or (3) doesn't stick

- **(2) Live Cloud Run env var** — a manual
  `gcloud run services update ... --update-env-vars=HIDDEN_FEATURES=...` changes
  the serving revision immediately, but the next CI deploy reads `DEPLOY_ENV_FILE`
  and overwrites it. (This is the "I bumped it and it reverted" loop.)
- **(3) GCP `memex-<env>-deploy-env`** — only the canonical-on-paper copy. CI
  doesn't read it. Changing it alone does nothing to CI deploys.

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

## Durably change what's hidden (the procedure that sticks)

GitHub Actions secrets are **write-only opaque blobs** — there is no way to patch
one line in place; you re-upload the whole `DEPLOY_ENV_FILE` body. Because the
local `scripts/deploy.<env>.env` and the GCP `memex-<env>-deploy-env` secret are
meant to mirror it, the safe flow is: rebuild the full body from the canonical GCP
copy, edit the one line, push it back to GitHub, and re-sync the GCP copy.

```bash
ENV=prod                              # or int
PROJECT=memex-ai-${ENV}
SRC=scripts/deploy.${ENV}.env
NEW_VALUE="spec-pause"                # the desired full slug list

# 1. Rebuild the full config body from the canonical GCP copy, flipping ONE line.
gcloud secrets versions access latest --secret="memex-${ENV}-deploy-env" --project="$PROJECT" \
  | sed -E "s/^(export[[:space:]]+)?HIDDEN_FEATURES=.*/HIDDEN_FEATURES=\"${NEW_VALUE}\"/" \
  > "$SRC"

# 2. Sanity-check just the line you changed.
grep HIDDEN_FEATURES "$SRC"

# 3. Push the whole body to the GitHub env secret CI actually reads (the durable fix).
gh secret set DEPLOY_ENV_FILE --env "$ENV" --repo mindset-ai/memex-ai < "$SRC"

# 4. Keep the canonical GCP copy in sync so the two stores don't drift.
gcloud secrets versions add "memex-${ENV}-deploy-env" --project="$PROJECT" --data-file="$SRC"

# 5. The local file holds DB coordinates — remove it once done (CI regenerates it).
rm "$SRC"
```

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

# Which GitHub env secrets exist (values are write-only, can't be read back):
gh secret list --env prod --repo mindset-ai/memex-ai
```

(`DEPLOY_ENV_FILE` is what governs the next deploy, but its value can't be read
back — confirm intended changes by inspecting the live service after a deploy, or
the GCP `memex-<env>-deploy-env` copy if it's been kept in sync.)
