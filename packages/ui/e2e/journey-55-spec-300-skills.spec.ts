import { test, expect, tenantPath, bareUrl, sendChat } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import { installAcEmission } from "./helpers/emit-ac.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// spec-300 t-9 — the PR-gate e2e journey for Skills (std-28). Drives the real UI
// end-to-end: a user UPLOADS a SKILL.md file into a Memex and attaches one
// auxiliary file, the file becomes a Skill scoped to that Memex, it appears in
// the Skills list, and its detail view renders the verbatim SKILL.md body plus
// the auxiliary-file table-of-contents. The whole author → list → view spine runs
// through the browser against a freshly-seeded, isolated tenant — no raw SQL, no
// faked server; the create POST executes the real Skills service.
//
// AC coverage (tagged in the afterEach installed below):
//   ac-1 — a user can upload a Markdown SKILL.md and it becomes a Skill scoped to
//          that Memex (the upload path fills the editor; create persists it).
//   ac-2 — a user can create a Skill in-app in Anthropic's verbatim SKILL.md
//          frontmatter format (name + description + body).
//
// ac-3 (in-app agent dispatch) and ac-4 (MCP list/get on the coding-agent side)
// are NOT exercised here — a pure-UI journey never invokes the agent loop or the
// /mcp surface. ac-4 is smoked live in packages/server/src/__smoke__ (authed
// tier, list_skills/get_skill). Tagging them here would assert something this
// test doesn't run.

const SPEC300 = "mindset-prod/memex-building-itself/specs/spec-300";
const AC_UPLOAD = `${SPEC300}/acs/ac-1`;
const AC_AUTHOR = `${SPEC300}/acs/ac-2`;
// spec-300 t-15 Increment 2 — the dedicated skills chat agent on the Skills page.
const AC_AGENT_SURFACE = `${SPEC300}/acs/ac-46`; // a chat agent in the shared shell
const AC_AGENT_AUTHORITY = `${SPEC300}/acs/ac-47`; // create/edit/archive via the validated write path
const AC_AGENT_JOURNEY = `${SPEC300}/acs/ac-53`; // the PR-gate e2e journey (std-28)

const TITLE =
  "a user uploads a SKILL.md with an auxiliary file, sees it in the Skills list, and opens its detail view";
const AGENT_TITLE =
  "a user asks the Skills-page agent to create a skill from a description, then to archive it — both go through the validated write path";

installAcEmission(test, import.meta.url, {
  [TITLE]: [AC_UPLOAD, AC_AUTHOR],
  [AGENT_TITLE]: [AC_AGENT_SURFACE, AC_AGENT_AUTHORITY, AC_AGENT_JOURNEY],
});

// A spec-valid SKILL.md: required frontmatter (name lowercase-alnum-hyphens,
// description) + a Markdown body. The [per std-28] cite exercises the in-app
// Standard-link rendering (ac-12) incidentally.
const SKILL_MD = `---
name: pr-test-checker
description: Reviews a pull request for missing tests and suggests the cases to add.
---

# PR test checker

Follow these steps to review a pull request for missing tests.

1. Read the diff and list every changed function.
2. Cross-reference each changed function against the test files.
3. Propose a concrete test case for every uncovered path.

Add any e2e coverage in conformance with [per std-28].
`;

// One auxiliary text file bundled alongside the SKILL.md (ac-13).
const AUX_FILE = `# Test-gap report template

- Changed function:
- Missing case:
- Suggested test:
`;

const BODY_MARKER = "Follow these steps to review a pull request for missing tests.";

test.describe("spec-300 — Skills author → list → view", () => {
  test(TITLE, async ({ page, resources }) => {
    // Fresh, isolated org tenant so the dev user opens the Memex as a writing
    // administrator (Skills writes require write access, dec-15) and the Skills
    // list starts genuinely empty. Tracked for afterEach teardown.
    const tenant = await seedOrgTenant({
      slug: resources.slug("spec300-skills"),
      ownerEmail: "dev@memex.ai",
      memexSlug: "skills",
    });

    // Bootstrap the dev session, then land on the seeded tenant's Specs board
    // (the settled entry point every org-tenant journey uses — mirrors
    // journey-26). From there reach Skills the way a user does: CLICK its sidebar
    // link (client-side SPA nav on the already-loaded tenant). This also asserts
    // the Skills entry is present in the primary navigation.
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await page.goto(
      tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"),
    );
    await expect(
      page.getByRole("heading", { name: "Specs" }),
    ).toBeVisible({ timeout: 15_000 });

    const skillsNavLink = page
      .getByRole("navigation")
      .getByRole("link", { name: "Skills", exact: true });
    await skillsNavLink.click();
    await expect(
      page.getByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("skills-empty")).toBeVisible();

    // ── AUTHOR ────────────────────────────────────────────────────────────────
    // Open the create modal (default mode is Upload).
    await page.getByTestId("new-skill-button").click();
    await expect(page.getByTestId("create-skill-modal")).toBeVisible();

    // ac-1: upload a Markdown SKILL.md — its contents load into the editor.
    await page.getByTestId("skill-md-file-input").setInputFiles({
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(SKILL_MD, "utf-8"),
    });
    const editor = page.getByTestId("skill-md-editor");
    await expect(editor).toHaveValue(/pr-test-checker/);

    // ac-13: attach one auxiliary text file alongside the SKILL.md.
    await page.getByTestId("aux-file-input").setInputFiles({
      name: "report-template.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(AUX_FILE, "utf-8"),
    });
    await expect(page.getByTestId("aux-file-row")).toHaveCount(1);

    // Declare a coarse capability flag (informs routing; enforces nothing).
    await page.getByTestId("capability-codebaseAccess").check();

    // Create — the modal lands the user on the new Skill's detail view. A fresh
    // Memex mints the first Skill deterministically as `skill-1`.
    await page.getByTestId("create-skill-submit").click();
    await page.waitForURL(/\/skills\/skill-1$/, { timeout: 15_000 });

    // ── VIEW (author → view) ───────────────────────────────────────────────────
    // The detail view renders the handle, the authored SKILL.md body, and the
    // auxiliary-file table-of-contents.
    await expect(page.getByText("skill-1", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(BODY_MARKER)).toBeVisible();
    await expect(page.getByTestId("skill-files")).toBeVisible();
    await expect(page.getByTestId("skill-file-row")).toContainText(
      "report-template.md",
    );
    // The [per std-28] cite renders as a clickable Standard link (ac-12).
    await expect(page.getByRole("link", { name: /std-28/ })).toBeVisible();
    await page.screenshot({
      path: "test-results/spec300-skills-1-detail.png",
      fullPage: true,
    });

    // ── LIST (appears in the Skills list) ──────────────────────────────────────
    // Back to the list via the sidebar (client-side nav on the settled tenant).
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Skills", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible({ timeout: 15_000 });
    const card = page
      .getByTestId("skill-card")
      .filter({ hasText: "pr-test-checker" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("skill-1");

    // ── VIEW (list → view) ─────────────────────────────────────────────────────
    // Re-open the detail from the list card and confirm the SKILL.md renders.
    await card.click();
    await page.waitForURL(/\/skills\/skill-1$/, { timeout: 15_000 });
    await expect(page.getByText(BODY_MARKER)).toBeVisible({ timeout: 15_000 });
  });

  // spec-300 t-15 Increment 2 (ac-46/ac-47/ac-53) — the dedicated skills chat agent
  // docked on the Skills page. Drives it end to end against a cold DB via the
  // deterministic Anthropic fake (MEMEX_ANTHROPIC_FAKE=1): the user describes a
  // skill and the agent CREATES it through the one validated update_skill write
  // path, then the user asks to archive it and the agent ARCHIVES it — both
  // verified against the real Skills service (GET /skills), not the fake. The agent's
  // authority is skills-only: update_skill is its sole write verb (asserted in the
  // server MODE_TOOLS unit tests). Mirrors the tool-use drive of journey-9.
  test(AGENT_TITLE, async ({ page, resources }) => {
    const tenant = await seedOrgTenant({
      slug: resources.slug("spec300-skills-agent"),
      ownerEmail: "dev@memex.ai",
      memexSlug: "skills",
    });

    const memexRef = `${tenant.namespaceSlug}/${tenant.memexSlug}`;
    const skillRef = `${memexRef}/skills/skill-1`;
    const apiBase =
      process.env.E2E_API_URL ??
      `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;
    const skillsApi = `${apiBase}/api/${tenant.namespaceSlug}/${tenant.memexSlug}/skills`;

    const AGENT_SKILL_MD = `---
name: commit-message-linter
description: Reviews a commit message for format and suggests fixes when it drifts from the convention.
---

# Commit message linter

1. Read the commit subject line and body.
2. Flag a subject over 50 characters or not in the imperative mood.
3. Suggest a corrected subject and body.
`;

    // Turn 1: the agent responds to the description by calling update_skill(create).
    // Turn 2: after the tool_result round-trips, it confirms in prose.
    await clearAnthropicQueue();
    await queueAnthropicResponse({
      textDeltas: [],
      content: [
        {
          type: "tool_use",
          id: "toolu_j55_create",
          name: "update_skill",
          input: { verb: "create", memex: memexRef, skill_md: AGENT_SKILL_MD },
        },
      ],
      stopReason: "tool_use",
    });
    await queueAnthropicResponse({
      // The UI renders the streamed deltas, so they must spell the full sentence.
      textDeltas: ["Created ", "the ", "commit-message-linter ", "skill."],
      content: [{ type: "text", text: "Created the commit-message-linter skill." }],
      stopReason: "end_turn",
    });

    // Land on the Skills page — the skills agent docks in the left rail (ac-46),
    // opens with the shared STATIC intro card (no opening LLM turn), and its input
    // is LIVE on arrival (skills mode binds no doc).
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/skills"));
    const panel = page.getByTestId("skills-assistant-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText("Skills agent")).toBeVisible();
    await expect(page.getByTestId("agent-intro-skills")).toBeVisible();
    await expect(page.getByTestId("chat-markdown")).toHaveCount(0);

    // ── CREATE BY DESCRIBING ────────────────────────────────────────────────────
    await sendChat(
      page,
      "Create a skill that lints commit messages and suggests fixes.",
    );
    await expect(page.getByTestId("chat-markdown")).toHaveText(
      /Created the commit-message-linter skill\./,
      { timeout: 15_000 },
    );

    // The skill really landed via the validated write path (ac-47) — GET /skills
    // from the real service now returns it. Poll: createSkill persists in-band, but
    // the SSE + fetch settle asynchronously.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(skillsApi);
          if (!res.ok()) return [] as string[];
          const body = (await res.json()) as Array<{ name: string }>;
          return body.map((s) => s.name);
        },
        { timeout: 10_000 },
      )
      .toContain("commit-message-linter");

    // ── ARCHIVE THROUGH THE AGENT ───────────────────────────────────────────────
    // Turn 3: the agent archives the skill (update_skill delete = soft-archive).
    // Turn 4: it confirms. Archiving is non-destructive but hides the skill from list.
    await queueAnthropicResponse({
      textDeltas: [],
      content: [
        {
          type: "tool_use",
          id: "toolu_j55_archive",
          name: "update_skill",
          input: { verb: "delete", ref: skillRef },
        },
      ],
      stopReason: "tool_use",
    });
    await queueAnthropicResponse({
      textDeltas: ["Archived ", "the ", "commit-message-linter ", "skill."],
      content: [{ type: "text", text: "Archived the commit-message-linter skill." }],
      stopReason: "end_turn",
    });

    await sendChat(page, "Archive that skill.");
    await expect(page.getByTestId("chat-markdown").last()).toHaveText(
      /Archived the commit-message-linter skill\./,
      { timeout: 15_000 },
    );

    // The archive really applied via the validated write path — the skill drops out
    // of the active list (archiving hides it from list/get, ac-8), proving the
    // agent's edit reached the real service, not just the chat transcript.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(skillsApi);
          if (!res.ok()) return ["<error>"];
          const body = (await res.json()) as Array<{ name: string }>;
          return body.map((s) => s.name);
        },
        { timeout: 10_000 },
      )
      .not.toContain("commit-message-linter");
  });
});
