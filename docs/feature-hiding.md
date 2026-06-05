# Feature Hiding Runbook (`HIDDEN_FEATURES`)

Operational runbook for hiding/unhiding soft-launched features per environment.

The server reads the `HIDDEN_FEATURES` env var at runtime via
`getHiddenFeatures()` (`packages/server/src/services/auth.ts`) and suppresses
the matching UI elements server-wide. No admin-bundle (SPA) rebuild is needed —
this is a server-side env var, picked up on the next `make deploy-server`.

## Slugs in play

| Slug         | Feature  |
|--------------|----------|
| `scaffold`   | spec-146 |
| `spec-pause` | spec-147 |
| `pulse`      | spec-148 |

## Semantics

- **Per-environment.** `HIDDEN_FEATURES` lives in each env's deploy config
  (`scripts/deploy.int.env`, `scripts/deploy.prod.env`), so int and prod are
  controlled independently.
- **All-or-nothing.** The value is a comma-separated slug list; a slug is either
  in the list (hidden) or not (shown). There is no partial/percentage rollout.
- **Fail-open (runtime).** On the running server, unset or empty
  `HIDDEN_FEATURES` => `getHiddenFeatures()` returns `[]` => nothing is hidden.
- **Deploy-time: unset ≠ empty (spec-168 dec-4).** A deploy only writes
  `HIDDEN_FEATURES` onto the service when the deployer's config **explicitly
  sets** it. If the value is **unset** (line absent/commented), the deploy
  **omits** it and leaves whatever is already live untouched — it will NOT blank
  an existing hidden state. An **explicit empty** value (`HIDDEN_FEATURES=""`) is
  a deliberate instruction to un-hide. This stops a deploy from a checkout that
  never set the value from silently un-hiding features (the failure mode that
  shipped prod rev `memex-api-00035` un-hidden).

## HIDE a feature

1. Edit the target env's deploy config and add the slug(s) to `HIDDEN_FEATURES`
   (comma-separated, no spaces required):
   - int  → `scripts/deploy.int.env`
   - prod → `scripts/deploy.prod.env`

   ```bash
   HIDDEN_FEATURES="scaffold,spec-pause,pulse"
   ```
2. Redeploy the server:
   ```bash
   make deploy-server            # int (ENV defaults to int)
   ENV=prod make deploy-server   # prod
   ```

No admin-bundle rebuild is required.

## UNHIDE a feature

1. In the target env's deploy config, **explicitly set** `HIDDEN_FEATURES` to the
   reduced slug list, or to `""` to unhide everything. ⚠️ **Deleting or
   commenting out the line does NOT unhide** (spec-168 dec-4) — an unset value is
   left untouched on the running service, so an explicit assignment is required
   to clear it:
   ```bash
   HIDDEN_FEATURES=""         # un-hide everything
   # HIDDEN_FEATURES="pulse"  # …or keep some hidden
   ```
2. Redeploy the server (`make deploy-server`, or `ENV=prod make deploy-server`
   for prod).

   Or clear it directly on the running service without a redeploy:
   ```bash
   gcloud run services update memex-api --region=us-east4 \
     --project=memex-ai-<env> --remove-env-vars HIDDEN_FEATURES
   ```

## Launch-env cutover

`HIDDEN_FEATURES` is **empty on both int and prod today** — fail-open, nothing
hidden. Once all three features ship, the launch-env cutover value will be:

```
HIDDEN_FEATURES="scaffold,spec-pause,pulse"
```

Arming prod is a deliberate, human-timed step: set that value in
`scripts/deploy.prod.env` and run `ENV=prod make deploy-server` at the
soft-launch cutover moment. Do not arm it ahead of time.
