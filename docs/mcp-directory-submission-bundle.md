# Anthropic Connectors Directory — submission bundle

Page-by-page paste sheet for the [submission form](https://docs.google.com/forms/d/e/1FAIpQLSeafJF2NDI7oYx1r8o0ycivCSVLNq92Mpc1FPxMKSw1CzDkqA/viewform)
(b-31 W8 t-17). Each field below mirrors the form's exact label, type, and
required flag. Pre-filled answers are ready to paste; **TODO** flags mark
anything that still needs a human call before submitting.

> The form has **6 pages**. Page 1 is intro-only. Pages 2–6 each have a
> heading below.

---

## Page 1 — Intro (no fields)

Acknowledges the [Software Directory Policy](https://www.anthropic.com/legal/software-directory-policy)
and Terms. Click **Next**.

---

## Page 2 — Submission Details

### Company Information

| # | Field | Type | Req | Value |
|---|---|---|---|---|
| 1 | Company/Organization Name | short | ✅ | `Mindset AI` |
| 2 | Company/Organization URL | short | ✅ | `https://www.mindset.ai` |
| 3 | Primary Contact Name | short | ✅ | `Ryan Soosayraj` |
| 4 | Primary Contact Email | short | ✅ | `ryan.soosayraj@mindset.ai` |
| 5 | Primary Contact Role | short | — | `Product, Memex.AI` *(TODO — confirm title)* |
| 6 | Anthropic Point of Contact (if known) | short | — | *(leave blank unless we have a named AE)* |

### Server Details

**Q7. MCP Server Name** — short, required.
*Help text: "As you'd like it to appear in the Directory. Do not include 'MCP' or 'Server' in the name"*

```
Memex.AI
```

**Q8. MCP Server URL — universal vs custom** — radio, required.

- [x] **Universal URL**
- [ ] Custom MCP URLs

**Q9. MCP Server URL** — long text, required.

```
https://memex.ai/mcp
```

**Q10. Tagline (max 55 characters)** — short, required.

```
Specs, decisions, and tasks — humans and agents aligned
```
*(exactly 55 characters)*

**Q11. MCP Server Description** — long, required. *50–100 words.*

```
Memex.AI is the shared system of record for teams shipping with AI agents.
Humans and agents draft, debate, and run Specs — living documents that
capture purpose, decisions, and tasks for a body of work. Once connected
to Claude, every conversation can search Specs, surface open decisions,
walk a Spec through draft → plan → build → verify → done with each phase's
rules enforced, and log every change so context never goes stale across
sessions. Memex keeps the human and the agent on the same plan.
```
*(83 words — within 50–100)*

**Q12. Use Cases + Examples** — long, required. *At least three.*

```
1. Catch up on what shipped this week
   Prompt: "What Specs landed in the mindset/main Memex this week?
   Summarise what changed."
   Claude calls list_memexes, list_docs (filtered by recent phase
   transitions), then get_doc on the top results to synthesise a digest
   grounded in the Specs, resolved decisions, and completed tasks.

2. Plan a new Spec collaboratively
   Prompt: "I want to start a new Spec for rewriting the onboarding flow.
   Help me shape it."
   Claude calls create_doc to open the Spec in draft, walks the planning
   rubric, and create_decision for each open question. Memex enforces
   the lifecycle: tasks can't be created until the Spec reaches build,
   so Claude resolves decisions first instead of skipping ahead.

3. Check whether a decision already exists
   Prompt: "Before I change how user sessions expire, has anyone
   already decided this?"
   Claude calls search_memex across Specs, decisions, and Standards,
   then cites the resolved decisions with canonical refs so the user
   can read the original context — no rediscovery, no re-litigation.
```

**Q13. Connection requirements** — long, required.

```
Free account at https://memex.ai. No paid plan, admin seat, or developer
seat required. The OAuth flow asks the user to pick one Org during
consent — the granted token is scoped to that Org plus the user's
personal Memex. Users in multiple Orgs can run the connector once per
Org to mint independent tokens. No geographic restrictions; no custom
instance URLs.
```

**Q14. Read/Write Capabilities** — radio, required.

- [ ] Read Only
- [ ] Write Only
- [x] **Read + Write**

**Q15. Is this an "MCP App" (has interactive UI elements)** — radio, required.

- [ ] Yes
- [x] **No**

*(Memex exposes data + tools, not MCP-UI widgets. Reconsider if/when we
ship MCP-UI resources.)*

**Q16. Third-party Connections and Web Access** — checkbox, required, multi.

- [ ] Web access
- [ ] Third-party AI model integration
- [ ] Third-party data retrieval
- [ ] Third-party data modification
- [x] **N/A**

*(Memex talks only to its own API. The one exception —
`memex__send_slack_message` — uses the **user's** connected Slack
account via Memex's own OAuth integration with Slack; it is not the MCP
server reaching out to arbitrary third parties on Claude's behalf. If a
reviewer flags this, fall back to "Third-party data modification".)*

**Q17. Data Handling** — checkbox, optional, multi.

- [x] Server only accesses data explicitly requested by user
- [x] No data is stored beyond session requirements *(tokens persist; per-call request data is not stored beyond the response)*
- [x] Data transmission is encrypted (HTTPS/TLS)
- [x] GDPR compliant (if applicable)

**Q18. Personal health data access** — radio, required.

- [ ] Yes
- [x] **No**

**Q19. Categories** — radio, optional.

- [x] **Business & Productivity**
- [ ] Communication
- [ ] Data & Analytics
- [ ] Development tools
- [ ] Financial Services
- [ ] Consumer Health
- [ ] Health & Life Sciences
- [ ] Media & Entertainment
- [ ] Commerce & Shopping

*(Alternative: pick "Development tools" if Memex's positioning at submission
time skews more dev-team-focused. Confirm with Barrie.)*

**Q20. Sponsored content or advertisements** — radio, required.

- [x] **No, there is no sponsored content or advertisements**
- [ ] Yes, there are banner ads or other paid visual elements
- [ ] Yes, the returned content or ranking of returned content is impacted by sponsorship or ad placement

### Authentication Details

**Q21. Authentication Type** — radio, required.

- [ ] No auth needed
- [x] **OAuth 2.0 (required for servers/tools needing auth)**
- [ ] Custom URL (not supported)

**Q22. Auth Client** — radio, optional.

- [ ] Static OAuth Client
- [x] **Dynamic OAuth Client (e.g., DCR, CIMD)**

**Q23. Static Client ID (if applicable)** — short, optional. → *Leave blank (DCR).*

**Q24. Static Client Secret (if applicable)** — short, optional. → *Leave blank (DCR).*

**Q25. Transport Support** — checkbox, required, multi.

- [x] **Streamable HTTP**
- [ ] SSE

### Documentation & Support

| # | Field | Value |
|---|---|---|
| 26 | MCP Server Documentation Link | `https://www.memex.ai/docs/claude/` |
| 27 | Privacy Policy | `https://www.memex.ai/legal/privacy/` |
| 28 | Data Processing Agreement URL (if applicable) | *(leave blank — no DPA published; TODO if any Enterprise customer requires)* |
| 29 | Support Channel | `support@mindset.ai` |

---

## Page 3 — Test Account Access

**Q30. Testing Account Credentials** — long, required.

Run `DATABASE_URL=<prod> pnpm --filter @memex/server db:seed-reviewer`
immediately before submitting; paste its output verbatim. Template the
script prints:

```
Memex.AI test account
URL: https://memex.ai
Email: mcp-review@memex.ai

Option A — OAuth (preferred):
  Use the Claude connector picker → Memex.AI → Connect.
  Sign in as mcp-review@memex.ai with password: <printed by seed script>
  Choose Org: "mcp-review" on the consent screen.

Option B — Legacy Personal Access Token (manual config):
  Authorization: Bearer mxt_<printed by seed script>
  Endpoint: https://memex.ai/mcp

Sample data: the mcp-review Org contains one Spec ("Onboarding rewrite")
with 5 sections, 3 resolved decisions, 1 open decision, tasks in each
status, and threaded comments on the Overview section and dec-1.
The user is also a member of the personal Memex `mcp-review/personal`
with one draft Spec for testing the draft → plan transition.
```

**Q31. Test Account Server URL (if different from main)** — short, optional. → *Leave blank — same as main URL.*

**Q32. Test Account Setup Instructions** — long, optional.

```
Recommended: use Option A (OAuth) — it exercises the production auth
path. Open Claude.ai → Connectors → Add custom connector →
"https://memex.ai/mcp". Sign in with the credentials above, accept the
consent screen, and the connector appears in the conversation picker.

Once connected, try these prompts to exercise the full surface:

  "List the Specs in mcp-review/onboarding."
    → list_memexes, list_docs

  "Open the Onboarding rewrite Spec and summarise the open decisions."
    → get_doc, list_comments

  "Resolve dec-1 with the 'gradual rollout' option."
    → resolve_decision (destructiveHint — Claude will confirm first)

  "Search for any decisions about session expiry across my memexes."
    → search_memex

If anything fails, contact ryan.soosayraj@mindset.ai. Tokens are valid
for 60 days from seed-script run.
```

**Q33. Test Data Availability** — checkbox, optional, multi.

- [x] Test account includes sample data
- [x] All tools can be tested with provided data

### Server Technical Details

**Q34. List of tools in your MCP Server** — short, required. *Format: `tool_name (human-readable name)`*

Source of truth: [docs/mcp-tool-inventory.md](mcp-tool-inventory.md).
Regenerate immediately before submitting:
`pnpm --filter @memex/server tsx scripts/generate-tool-inventory.ts`

```
list_memexes (List Memexes), list_docs (List documents), get_doc (Get document), create_doc (Create document), update_doc (Update document), add_section (Add section), update_section (Update section), create_decision (Create decision), update_decision (Update decision), resolve_decision (Resolve decision), approve_candidate (Approve candidate decision), reject_candidate (Reject candidate decision), list_tasks (List tasks), create_task (Create task), update_task (Update task), delete_task (Delete task), add_comment (Add comment), list_comments (List comments), update_comment (Update comment), assess_brief (Assess Spec), publish_brief (Publish Spec), search_memex (Search Memex), memex__send_slack_message (Send Slack message)
```

*(23 tools. Human-readable names mirror the inventory file; "Assess
Spec" / "Publish Spec" replace the older "Brief" wording.)*

**Q35. Tool Titles & Annotations** — checkbox, required, multi.

- [x] **I've specified user-friendly titles for all tools in my server**
- [x] **I've specified accurate tool annotations for all tools in my server**

**Q36. List of resources in your MCP Server** — short, optional.
→ *Leave blank — Memex MCP exposes no MCP resources today.*

**Q37. List of prompts in your MCP Server** — short, optional.
→ *Leave blank — Memex MCP exposes no MCP prompts today.*

---

## Page 4 — Launch Readiness & Listing Media Materials

**Q38. Timeline — Server GA Date** — date, optional.

```
2026-06-02
```

*(TODO — confirm with Barrie. Set to the deploy-server prod date once
all Page 6 checklist items are green. Form note: "we can only include
servers in our Directory that are in GA".)*

**Q39. Confirm testing is complete & your server works as intended in** — checkbox, required, multi.

- [x] **Claude.ai (web)**
- [x] **Claude Desktop**
- [ ] Claude Code *(not required)*
- [ ] Cowork *(not required)*

*(Form note: Claude Code and Cowork compatibility is not required. We do
support both via the same `/mcp` endpoint — opt in once smoke-tested.)*

**Q40. Server Logo** — short, required. *Square 1:1 SVG; URL preferred.*

```
https://www.memex.ai/branding/memex-wordmark.svg
```

Asset: black wordmark + triangle mark, 120×120 canvas (1:1), transparent
background. Saved at `memex-website/branding/memex-wordmark.svg` —
deploys with the next `memex-website` push. **TODO — deploy
memex-website then curl the URL to confirm 200 + correct content.**

Fallback if the prod URL isn't live yet at submit time: upload
`memex-website/branding/memex-wordmark.svg` to a Google Drive folder set
to "Anyone with the link can view" and paste that URL instead.

**Q41. Server Logo URL — favicon verification** — checkbox, required.

- [ ] **I have verified that the favicon is correct** — tick only after the deploy + cache-refresh below.

The directory listing pulls its tool-call icon from
`https://www.google.com/s2/favicons?domain=memex.ai&sz=64`, which is
fed by the site's `<link rel="icon">` declaration. Only
`memex-website/assets/favicon.svg` is referenced (no `/favicon.ico` or
`/favicon.png` fallbacks — verified both return 404).

Status:
- ✅ Updated `memex-website/assets/favicon.svg` to the navy isometric
  triangle mark (same path as the triangle inside the wordmark).
  Replaces the old pink-stroke-on-dark-navy-rounded-square version.
- 🔲 **TODO — redeploy:** from `memex-website/`, run
  `gcloud config set project memex-ai-prod && bash scripts/deploy.sh`.
  CDN invalidation is async (30–60s). Hard-refresh `memex.ai` with
  Cmd+Shift+R to confirm the new triangle is live.
- 🔲 **TODO — Google s2 cache:** `https://www.google.com/s2/favicons?domain=memex.ai&sz=64`
  caches independently of memex.ai's CDN. After the redeploy, the s2
  endpoint may keep serving the old icon for hours-to-days. Force a
  refresh by visiting `https://www.memex.ai/?cachebust=1` in a logged-out
  browser, then re-fetching the s2 URL. If still stale at submit time,
  add a note in the Q53 Additional Information field flagging this for
  the reviewer.
- 🔲 **TODO — `branding/favicon.png`:** still holds the old PNG raster
  of the old design. Not referenced by any HTML, but shown on the
  internal `/branding/` page. Replace with a PNG of the new triangle
  mark whenever convenient — not blocking submission.

**Q42. Promotional Images of MCP Server** — short, optional. *3–5 screenshots, ≥1000px wide PNGs preferred.*

```
https://drive.google.com/drive/folders/1JuqJ3n8z5kjh5ZP0yMXEESVG7gLU2mbb
```

Drop the following into a Drive folder set to "Anyone with the link can
view":

1. **Hero / OG card** (1200×630 PNG, supplied) — the tagline graphic
   "Specs, decisions, and tasks — humans and agents aligned". Also
   lives at `memex-website/branding/og-card.png` once the new file
   replaces the old one. **TODO — replace the existing
   `og-card.png` (the old version doesn't have the tagline) and
   redeploy memex-website.**
2. **Screenshot — search_memex** — Claude.ai window mid-conversation
   showing search results grouped across the Brief, decisions, and the
   Standard.
3. **Screenshot — delete_task confirmation** — Claude's destructiveHint
   prompt asking the user to confirm before calling `delete_task` (the
   only destructive tool in v1 — `resolve_decision` is a reversible
   write and does NOT prompt). Create a throwaway task first, then
   delete it, so no seeded data is touched.
4. **Screenshot — get_doc** — Claude returning the rendered Brief
   structure (sections, decisions, tasks) inline.

**TODO — capture screens 2–4 against the `memex-reviewer` Org ("Memex
Reviewer Sandbox") — seeded on prod 2026-06-01 via `db:seed-reviewer`;
export at ≥1000px wide; drop in the Drive folder.**

**Q43. Link to Promotional Materials** — long, optional.

```
Drive folder: <same URL as Q42>

Matching prompts:
  1. Hero card — no prompt; standalone marketing graphic.
  2. Screenshot 2 — "Search the Memex Reviewer Sandbox for everything
     about how reviewers exercise tools."
  3. Screenshot 3 — "Create a task 'temp — delete me' on the sample
     Brief, then delete it."
  4. Screenshot 4 — "Open the Anthropic Connectors Directory sample
     Brief and summarise its open decisions."
```

---

## Page 5 — Skills & Plugins *(all optional)*

Skip this page unless we're submitting a Skill alongside. Per b-31 dec-9,
no Skill is shipping with the v1 listing — leave Q44–Q48 blank.

| # | Field | Value |
|---|---|---|
| 44 | Skill Name | — |
| 45 | Skill Description | — |
| 46 | GitHub URL of Skill | — |
| 47 | Extra Information on Skills | — |
| 48 | Related Plugins | — |

---

## Page 6 — Submission Requirements Checklist

**Q49. Policy Compliance** — checkbox, required, multi.

- [x] I have reviewed and agree to the Software Directory Policy.
- [x] My server does NOT enable cross-service automation
- [x] My server does NOT transfer money, cryptocurrency, or execute financial transactions
- [x] My MCP server is live, published, and ready to accept production traffic. *(TODO — confirm after prod deploy)*
- [x] I work for the company that owns or controls the API endpoint(s) that my server connects to.

**Q50. Technical Requirements** — checkbox, required, multi.

- [x] OAuth 2.0 is fully implemented for ALL tools requiring authentication
- [x] All tools include proper safety annotations (readOnlyHint, destructiveHint)
- [x] Server is accessible via HTTPS (not HTTP)
- [x] CORS is properly configured for browser-based authentication
- [ ] Claude.ai and Claude Code IP addresses are allowlisted (if applicable) *(N/A — no IP allowlist; leave unticked. Confirm form accepts this since "if applicable".)*
- [x] I have tested this works with Claude.ai on the latest build *(TODO — final smoke before submit)*

**Q51. Documentation Requirements** — checkbox, required, multi.

- [x] Complete server documentation is published and publicly accessible
- [x] Documentation includes setup instructions, tool descriptions, and troubleshooting guide
- [x] Company privacy policy is published and accessible
- [x] Terms of service are published and accessible

**Q52. Testing Requirements** — checkbox, required, multi.

- [x] Test account with sample data is ready (if relevant)
- [x] Test credentials are valid for at least 30 days (if relevant)
- [x] All server tools are functional and tested in the surfaces in which they'll be available (claude.ai, Claude Code, etc)

**Q53. Additional Information** — long, optional.

```
A note on scope semantics: each OAuth token grants access to the user's
personal Memex plus ONE chosen Org (selected at consent). Users in
multiple Orgs run the connector once per Org. The token's `org` claim
is enforced on every MCP call — out-of-scope Memexes return 404 (same
shape as a non-membership miss, per our std-7 no-info-leak rule). This
is intentionally more restrictive than the legacy mxt_ Personal Access
Token path, which remains supported for CLI / scripted clients only.

Tool inventory: 23 tools — 6 read-only, 1 destructive (delete_task,
carries destructiveHint so Claude prompts before calling), 16 reversible
writes. Most write operations are reversible by design (update_* rather
than separate set_status / add_blocker / remove_blocker).
```

---

# Reference material

## Pre-submit checklist (run in order)

- [ ] All b-31 W1–W8 tasks merged to `main`.
- [ ] `make deploy-server` to prod completed.
- [ ] Migration `0045_add_oauth.sql` applied to prod DB.
- [ ] `OAUTH_ENABLED=1` set on prod Cloud Run.
- [ ] `DATABASE_URL=<prod> pnpm --filter @memex/server db:seed-reviewer` run; output captured for Q30.
- [ ] `docs/mcp-oauth-smoke-test.md` walked against prod URL — all steps green.
- [ ] `docs/mcp-tool-inventory.md` regenerated and pushed to `main`; Q34 string re-pasted from the latest file.
- [ ] All 5 internal users migrated to OAuth (Slack confirmation thread).
- [ ] `memex-website/branding/memex-wordmark.svg` deployed and `curl -I https://www.memex.ai/branding/memex-wordmark.svg` returns 200.
- [ ] `memex-website/branding/og-card.png` replaced with the new tagline version and redeployed.
- [ ] `memex-website/assets/favicon.svg` deployed (after `bash scripts/deploy.sh` from `memex-website/`) and `https://www.memex.ai/assets/favicon.svg` serves the navy triangle.
- [ ] Favicon at `https://www.google.com/s2/favicons?domain=memex.ai&sz=64` shows the Memex triangle mark (Google's s2 cache may lag the CDN — recheck shortly before submit).
- [ ] Promo Drive folder populated: 1 hero (OG card) + 3 Claude.ai screenshots (search_memex / resolve_decision / get_doc), each ≥1000px wide.
- [ ] Q38 GA date filled with the actual prod-deploy date.
- [x] Privacy Policy live at `https://www.memex.ai/legal/privacy/` (W7).
- [x] Terms of Service live at `https://www.memex.ai/legal/terms/` (W7).
- [x] Public docs page live at `https://www.memex.ai/docs/claude/` (W6).
- [x] `memex-ai@2.0.1` published to npm (W9) — published 2026-05-22 by `barriehadfield-mindset`; ships the `13611d7` DEFAULT_API_BASE fix. `npx -y memex-ai@2.0.1 --help` verified.

## After-submission monitoring

Anthropic review takes ~2 weeks per round. First-round rejection is common
(per b-31 Risks):

- Most-cited reason: tool annotation misclassification.
- Watch `[MCP unexpected error]` in Cloud Run logs — request IDs from
  reviewer reports correlate here.
- Reviewer email: `mcp-review@anthropic.com`. Ryan owns the response
  thread (per b-31 dec-4).

## Reviewer credentials — operator notes

Provision with:

```bash
DATABASE_URL=<prod> pnpm --filter @memex/server db:seed-reviewer
```

The script prints both an OAuth-flow password and a fresh `mxt_` PAT.
Paste the full block into the Q30 form field. Each run mints fresh
credentials — rotate before every submission round to limit blast
radius.

## OAuth technical reference

| Field | Value |
|---|---|
| **Type** | OAuth 2.1 with Dynamic Client Registration + PKCE |
| **Issuer** | `https://memex.ai` |
| **OAuth metadata** | `https://memex.ai/.well-known/oauth-authorization-server` |
| **Authorization endpoint** | `https://memex.ai/api/oauth/authorize` |
| **Token endpoint** | `https://memex.ai/api/oauth/token` |
| **Registration endpoint** | `https://memex.ai/api/oauth/register` |
| **Revocation endpoint** | `https://memex.ai/api/oauth/revoke` |
| **PKCE methods supported** | `S256` only |
| **Scopes** | `memex.full` — single scope, Org-scoped grant |
| **Access token TTL** | 3600s (1 hour) — JWT, signed HS256, carries `org` claim |
| **Refresh token TTL** | 30 days, rotating, single-use with reuse detection |

## Branding asset paths

| Asset | Form field | Repo path (memex-website) | Hosted URL |
|---|---|---|---|
| Wordmark SVG (1:1, 120×120, supplied) | Q40 Server Logo | `branding/memex-wordmark.svg` ✅ saved | https://www.memex.ai/branding/memex-wordmark.svg (pending deploy) |
| Triangle favicon | Q41 favicon check | `branding/favicon.png` (verify content matches the supplied triangle mark) | https://www.google.com/s2/favicons?domain=memex.ai&sz=64 |
| OG card with tagline (1200×630 PNG, supplied) | Q42 Promo Images | `branding/og-card.png` (TODO — replace; current file is the old version without the tagline) | https://www.memex.ai/branding/og-card.png |

The legacy `branding/memex-logo.svg` (32×32 origami triangle on dark
navy) is **not** the right asset for this submission — Anthropic's
directory wants a square logo that reads well at 64–128px, and the new
wordmark is what marketing wants on the listing. Left it in place so
nothing breaks on the live site.

**TODO before submission:**
- Push `memex-wordmark.svg` to prod and curl-verify the hosted URL.
- Replace `branding/og-card.png` with the new tagline version and
  redeploy.
- Open the favicon URL in a browser and confirm it shows the triangle
  mark.
