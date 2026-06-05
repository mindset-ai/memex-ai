# MCP OAuth smoke test — Anthropic Connectors Directory submission

Procedure for verifying that the OAuth-protected `/mcp` endpoint behaves
correctly against the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
before submitting to the Anthropic Connectors Directory.

Run this against `https://int.memex.ai/mcp` (with `OAUTH_ENABLED=1` set) before
flipping the flag in prod, and again against `https://memex.ai/mcp` immediately
after the prod flip.

---

## Prerequisites

- `OAUTH_ENABLED=1` set on the target environment.
- Migration `0045_add_oauth.sql` applied.
- Migration `0047_oauth_method_check_s256.sql` applied (DB-level CHECK
  constraint enforcing PKCE `S256`-only — t-28).
- A test user account (the e2e test seeds one; reviewer account from W5/t-10
  is the right thing to use in prod).
- Node.js + `npx` available locally.

## 1. Discovery — `.well-known` documents

Verify the two metadata documents are reachable and well-formed:

```bash
curl -s https://int.memex.ai/.well-known/oauth-authorization-server | jq .
curl -s https://int.memex.ai/.well-known/oauth-protected-resource | jq .
```

Both should return 200 with JSON. The authorization-server doc MUST include:

- `issuer`: matches the base URL
- `authorization_endpoint`: `<base>/api/oauth/authorize`
- `token_endpoint`: `<base>/api/oauth/token`
- `registration_endpoint`: `<base>/api/oauth/register`
- `revocation_endpoint`: `<base>/api/oauth/revoke`
- `response_types_supported`: `["code"]`
- `grant_types_supported`: `["authorization_code", "refresh_token"]`
- `code_challenge_methods_supported`: `["S256"]` (S256 **only**)
- `scopes_supported`: `["memex.full"]`

The protected-resource doc MUST include:

- `resource`: `<base>/mcp`
- `authorization_servers`: `[<base>]`
- `scopes_supported`: `["memex.full"]`
- `bearer_methods_supported`: `["header"]`

**Host validation (t-23).** The URLs in both documents are built from
`X-Forwarded-Host` only when that header strips down to a host on the
`ALLOWED_HOSTS` allowlist exported from
`packages/server/src/middleware/memex-resolver.ts` (re-imported by
`routes/well-known.ts`). Anything else falls back to the `Host` header.
That allowlist is the canonical source — currently `memex.ai`,
`www.memex.ai`, `int.memex.ai`, `localhost`, `127.0.0.1`, `0.0.0.0`.
(`mcp.memex.ai` and `int-mcp.memex.ai` retired — both prod and int now
serve API + MCP from the apex, path-routed per spec-9 dec-2 v4 + spec-59.) A
spoofed `X-Forwarded-Host: evil.com` MUST be ignored (see Section 7).

## 2. Launch the Inspector

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI:

- **Transport**: HTTP (Streamable)
- **URL**: `https://int.memex.ai/mcp`
- **Auth**: OAuth (the Inspector autodiscovers via the well-known docs)

Click **Connect**.

## 3. Complete the OAuth flow

Inspector should:

1. Hit `/.well-known/oauth-authorization-server`.
2. POST `/api/oauth/register` with metadata (client_name, redirect_uris).
3. Open a browser tab to `/api/oauth/authorize?...`.

The browser:

- 302s to `/oauth/authorize?...` (React consent page).
- Shows **Memex Inspector** (or whatever the Inspector self-registered as) +
  "Full access to your Memexes…".
- You click **Allow**.
- 302s back to the Inspector's loopback URL with `?code=...&state=...`.

Inspector:

4. POSTs `/api/oauth/token` with grant_type=authorization_code.
5. Receives `access_token` (JWT) + `refresh_token` + `expires_in: 3600`.
6. Reconnects to `/mcp` with `Authorization: Bearer <access_token>`.

The Inspector should now show the full tool list (31 tools).

## 4. Exercise every tool

For each tool in the catalogue, call it with a representative payload from
the Inspector. **Required by Anthropic review**: every tool must execute
without erroring and return a sensible response.

Tools worth manually exercising:

- `list_memexes()` → returns the test user's Memexes
- `list_docs({ memex: "test-org/main" })` → returns active Specs
- `create_doc(...)` with `verbose: true` → writes a Spec, returns the
  full markdown doc state
- `delete_task(...)` — **destructive**, confirm Claude prompts the user
  before calling (validates the `destructiveHint: true` annotation).

If any tool returns a leaked stack trace or generic "Internal Server Error",
the `handleError` change in W4 has regressed. Capture the request ID from
the response and grep Cloud Run logs.

### Clock-skew rejection (t-29)

Mint an access token with `AUTH_JWT_SECRET` set to a known value, then
hand-craft a JWT whose `iat` is 5 minutes in the future. `/mcp` must reject
it with 401 — the verifier in
`packages/server/src/services/oauth/access-tokens.ts` rejects `iat > now +
60s` and also rejects tokens missing `iat` entirely.

```bash
# With AUTH_JWT_SECRET="<known>" set on the target environment.
SECRET="<known>"
NOW=$(date +%s)
IAT=$((NOW + 300))                       # 5 minutes in the future
EXP=$((NOW + 3900))
HEADER=$(printf '{"alg":"HS256","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-')
PAYLOAD=$(printf '{"sub":"%s","iss":"memex-oauth","aud":"memex-mcp","client_id":"%s","org":"%s","scope":"memex.full","iat":%s,"exp":%s}' \
  "<user-uuid>" "<client-id>" "<org-uuid>" "$IAT" "$EXP" \
  | base64 | tr -d '=' | tr '/+' '_-')
SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" \
  | openssl dgst -binary -sha256 -hmac "$SECRET" \
  | base64 | tr -d '=' | tr '/+' '_-')
TOKEN="$HEADER.$PAYLOAD.$SIG"

curl -i -s https://int.memex.ai/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return `401`. Repeat with `iat` set to 30s in the future — that one
should be accepted (60s skew tolerance).

Exact 401 contract (confirmed against `packages/server/src/app.ts:259-277`):

- Status: `401`
- Header: `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://int.memex.ai/.well-known/oauth-protected-resource"`
- Body:
  ```json
  {
    "error": "Invalid OAuth access token",
    "code": "token_invalid",
    "message": "Reconnect via the Anthropic Connectors picker or re-run `claude mcp add memex`."
  }
  ```

The verifier throws `InvalidAccessTokenError("iat in the future")` from
`services/oauth/access-tokens.ts:150` and the `/mcp` boundary catches it in
the `else if (isOAuthEnabled())` branch, formatting the
`WWW-Authenticate` header + JSON body shown above — the verifier's
specific message is intentionally swallowed (no oracle for legitimate vs
skewed-clock callers).

## 5. Refresh-token rotation

Force the Inspector to refresh by waiting >1h, or manually inspect by:

```bash
# With the access_token + refresh_token captured from above:
curl -s https://int.memex.ai/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"refresh_token","refresh_token":"<refresh>","client_id":"<id>","client_secret":"<secret>"}'
```

Should return a new access+refresh pair. Replay the OLD refresh:

```bash
# Same command, OLD refresh_token
```

Should return `401 { "error": "invalid_grant", "error_description": "refresh token reuse detected; chain revoked" }`. Confirm the chain is revoked by trying the NEW refresh_token — that should now also fail with `400 invalid_grant`.

> **Atomicity note (t-30).** `rotateRefreshToken` now runs inside a single
> `db.transaction`, so a crash mid-rotation can't leave an orphaned chain
> (old token revoked but new one not minted, or vice versa). Behaviour from
> the smoke perspective is unchanged — both the OLD and NEW endpoints
> behave exactly as above — but the failure mode where a server restart
> mid-rotation would brick the chain is closed.
>
> **State-leak collapse (t-26).** As of the state-leak fix, the
> `ValidationError` branches in `handleRefreshToken` — not-found / expired
> / revoked / wrong-client — all collapse to the byte-identical body
> `{"error":"invalid_grant","error_description":"invalid_grant: refresh
> token rejected"}` with status `400`. The reuse-detected message above
> (`RefreshTokenReuseError` branch, `401`) is intentionally kept distinct
> — it's the only signal we deliberately surface so a legitimate client
> can recognise that a chain has been compromised and force a fresh login.

## 6. Revocation

Revoke the active refresh token:

```bash
curl -i -s https://int.memex.ai/api/oauth/revoke \
  -H "Content-Type: application/json" \
  -d '{"token":"<refresh>","token_type_hint":"refresh_token","client_id":"<id>","client_secret":"<secret>"}'
```

Should return `200` (RFC 7009 always returns 200). Subsequent /token with the
revoked refresh should fail `invalid_grant`.

## 7. Reject scenarios

Verify the security guards still catch bad input. Each should return a 4xx
with the structured RFC 6749 error shape:

| Test | Expected |
|---|---|
| POST `/api/oauth/token` without `client_id` | 401 `invalid_client` |
| POST `/api/oauth/token` with wrong `client_secret` | 401 `invalid_client: client authentication failed` — body byte-identical to unknown-client_id below (t-25) |
| POST `/api/oauth/token` with unknown `client_id` | 401 `invalid_client: client authentication failed` (t-25) |
| POST `/api/oauth/token` with reused `code` | 400 `invalid_grant: code already used` |
| POST `/api/oauth/token` with wrong PKCE verifier | 400 `invalid_grant: PKCE verifier mismatch` |
| POST `/api/oauth/token` with mismatched `redirect_uri` | 400 `invalid_grant: redirect_uri mismatch` |
| POST `/api/oauth/token` with **revoked / wrong-client / unknown** `refresh_token` | 400 `invalid_grant: refresh token rejected` — all three byte-identical (t-26) |
| POST `/api/oauth/register` with `redirect_uris: ["http://attacker.com/cb"]` | 400 `invalid_client_metadata: redirect_uri must be https://` |
| POST `/api/oauth/register` with **11 `redirect_uris`** | 400 `invalid_client_metadata: redirect_uris exceeds maximum of 10` (t-32) |
| POST `/api/oauth/register` with `code_challenge_method=plain` (if surfaced at registration) | rejected at runtime AND by DB-level CHECK from migration `0047` (t-28) |
| **11th** POST `/api/oauth/register` from one IP within an hour | 429 `too_many_requests` + `Retry-After` header (t-31) |
| GET `/.well-known/oauth-authorization-server` with `X-Forwarded-Host: evil.com` | 200, but body MUST NOT contain `evil.com` anywhere — falls back to `Host` (t-23) |
| POST `/api/oauth/revoke` with **another client's** refresh_token | 200 (RFC 7009 §2.1 — no info leak), but the token MUST NOT actually be revoked (t-27) |
| Connect to `/mcp` with no Authorization header | 401 + `WWW-Authenticate: Bearer resource_metadata=...` |

### Verification commands for the new cases

Anthropic's directory review specifically grades the byte-identity guarantees
(t-25, t-26), so use `diff` rather than eyeballing the bodies. The canonical
contracts are pinned in
`packages/server/src/__security__/oauth-error-shapes.security.test.ts`.

**t-25 — `/token` client-auth byte-identity.**

```bash
# (a) unknown client_id
curl -s -o /tmp/oauth-a.json -w "%{http_code}\n" \
  https://int.memex.ai/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","code":"x","code_verifier":"x","redirect_uri":"https://test.example/cb","client_id":"totally-unknown-xxxxx","client_secret":"any"}'

# (b) known client_id with bogus secret
curl -s -o /tmp/oauth-b.json -w "%{http_code}\n" \
  https://int.memex.ai/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","code":"x","code_verifier":"x","redirect_uri":"https://test.example/cb","client_id":"<known-client>","client_secret":"not-the-real-secret"}'

diff /tmp/oauth-a.json /tmp/oauth-b.json    # MUST be empty
```

Both must be `401` with body `{"error":"invalid_client","error_description":"client authentication failed"}`.

**t-26 — `/token` refresh-token byte-identity.**

```bash
# unknown
curl -s -o /tmp/rt-unknown.json -w "%{http_code}\n" \
  https://int.memex.ai/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"refresh_token","refresh_token":"does-not-exist","client_id":"<id>","client_secret":"<secret>"}'

# revoked  (first /revoke a real refresh_token, then replay it here)
# wrong-client  (use clientA's refresh_token while authenticating as clientB)

diff /tmp/rt-unknown.json /tmp/rt-revoked.json        # MUST be empty
diff /tmp/rt-unknown.json /tmp/rt-wrong-client.json   # MUST be empty
```

All three must be `400` with body `{"error":"invalid_grant","error_description":"invalid_grant: refresh token rejected"}`.

**t-31 — `/register` IP rate-limit.**

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " \
    https://int.memex.ai/api/oauth/register \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 203.0.113.10" \
    -d "{\"client_name\":\"rl-test-$i\",\"redirect_uris\":[\"https://example.com/cb\"]}"
done
echo
# 11th call — must be 429 + Retry-After
curl -i -s https://int.memex.ai/api/oauth/register \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 203.0.113.10" \
  -d '{"client_name":"rl-test-11","redirect_uris":["https://example.com/cb"]}' \
  | grep -iE '^(HTTP|Retry-After)'
```

Expected: ten `201`s, then `HTTP/1.1 429` + `Retry-After: <seconds>`.

`clientIp()` precedence (`routes/auth/helpers.ts:22-29`):

1. `x-forwarded-for` — first IP in the comma-separated chain, trimmed
2. `cf-connecting-ip`
3. `x-real-ip`
4. `"unknown"` (rate-limiter degrades to per-email scoping)

GCP HTTPS Load Balancer + Cloud Run set `X-Forwarded-For: <client>, <LB>`
on every request, so the first-token `split(",")[0]` reads the real
client IP. The rate-limit bucket therefore keys correctly. The eleventh
request from the smoke test above will return `429` against int —
**flip to RED if it doesn't**: it would mean the bucket key collapsed to
a shared upstream IP (LB / proxy / NAT) and the smoke must be repeated
from a different source IP to disprove the failure mode. If the failure
reproduces, the regression is in either `clientIp()` precedence or the
LB header rewrite — start with `packages/server/src/routes/auth/helpers.ts`.

**t-32 — `/register` redirect_uris cap.**

```bash
URIS=$(python3 -c 'import json; print(json.dumps([f"https://example.com/cb{i}" for i in range(11)]))')
curl -i -s https://int.memex.ai/api/oauth/register \
  -H "Content-Type: application/json" \
  -d "{\"client_name\":\"cap-test\",\"redirect_uris\":$URIS}"
```

Expected: `400 { "error": "invalid_client_metadata", "error_description":
"redirect_uris exceeds maximum of 10" }`.

**t-23 — `/.well-known` host spoof.**

```bash
curl -s https://int.memex.ai/.well-known/oauth-authorization-server \
  -H "X-Forwarded-Host: evil.com" \
  | tee /tmp/wk.json | jq .
grep -c "evil.com" /tmp/wk.json    # MUST print 0
```

Repeat for `/.well-known/oauth-protected-resource`. Then verify that an
allowlisted `X-Forwarded-Host` (e.g. `int.memex.ai`) IS honoured — issuer
and endpoints should rewrite to `https://int.memex.ai/...`.

**t-28 — PKCE `S256`-only (defence in depth).** The well-known doc
advertises `code_challenge_methods_supported: ["S256"]`. Two layers
enforce this:

1. Runtime: `/authorize` rejects non-S256 `code_challenge_method` before
   any code is minted. Three layers, in call order:
   - **GET preview** (`routes/oauth/authorize.ts:53-54`) — returns
     `{ error: "code_challenge_method must be 'S256'" }` on the preview
     payload so the consent screen never renders for a non-S256 client.
   - **POST allow/deny** (`routes/oauth/authorize.ts:162-163`) — returns
     `400 { "error": "invalid_request", "error_description":
     "code_challenge_method must be S256" }` before any code is minted.
   - **Defense in depth** (`services/oauth/codes.ts:53`) — `createAuthorizationCode`
     throws `ValidationError("OAuth 2.1 requires code_challenge_method=S256")`
     if a future caller ever reaches code minting with a non-S256 method.

   Smoke request shape for the failing case:
   ```bash
   curl -i -s "https://int.memex.ai/api/oauth/authorize?response_type=code&client_id=<id>&redirect_uri=<uri>&code_challenge=abc&code_challenge_method=plain"
   ```
   Expect `400` with `error_description` mentioning `S256`.
2. DB: migration `0047_oauth_method_check_s256.sql` adds a CHECK
   constraint so any INSERT with `code_challenge_method <> 'S256'` fails
   at the row level — a belt-and-braces guard against a future code-path
   that forgets the runtime check.

**t-27 — cross-client revoke (RFC 7009 §2.1).**

```bash
# (a) own token — should 200 AND actually revoke
curl -i -s https://int.memex.ai/api/oauth/revoke \
  -H "Content-Type: application/json" \
  -d '{"token":"<clientA-refresh>","token_type_hint":"refresh_token","client_id":"<clientA-id>","client_secret":"<clientA-secret>"}'

# (b) someone else's token — should 200 but NOT actually revoke
curl -i -s https://int.memex.ai/api/oauth/revoke \
  -H "Content-Type: application/json" \
  -d '{"token":"<clientA-refresh>","token_type_hint":"refresh_token","client_id":"<clientB-id>","client_secret":"<clientB-secret>"}'
```

Verify (b) didn't actually revoke by replaying clientA's refresh_token at
`/token` — it should still succeed and rotate normally.

## 8. Coexistence sanity (until mxt_ is sunset)

Verify the existing `mxt_` path still works:

```bash
# With a current mxt_ token from /settings/tokens:
curl -s https://int.memex.ai/mcp \
  -H "Authorization: Bearer mxt_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return the same tool list as the OAuth path. This proves the
token-prefix fork hasn't broken existing installs.

---

## Failure runbook

- **/.well-known returns 404** → `OAUTH_ENABLED` is unset on the target. Set it.
- **/register returns 404** → same.
- **Inspector times out at /authorize** → the React consent page is not deployed
  (admin deploy needed) or the route is mis-mounted. Check `/oauth/authorize`
  loads in a browser.
- **/token returns 500** → check Cloud Run logs. The handleError change in W4
  means the response should carry a request ID; grep `[MCP unexpected error]
  request=<uuid>` to find the underlying exception.

## What to capture for Anthropic submission

After step 4 finishes cleanly:

- Screenshot of the Inspector tool list (31 tools).
- Screenshot of the consent screen.
- Note the test reviewer account credentials (W5/t-10).

Include all three in the directory submission form.
