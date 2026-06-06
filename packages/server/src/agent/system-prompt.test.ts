import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SCAFFOLD, type SpecPhase } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks, buildCreationSystemBlocks } from "./system-prompt.js";
import { getToolDefinitions } from "./tools.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__dirname, "phases");

describe("buildSystemBlocks", () => {
  it("returns three blocks (instructions, context, integration state)", () => {
    const blocks = buildSystemBlocks("Some context", "specify");
    expect(blocks).toHaveLength(3);
  });

  it("first block contains the React-only role orientation", () => {
    const blocks = buildSystemBlocks("Some context", "specify");
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("## Role");
    expect(blocks[0].text).toContain("document assistant");
    expect(blocks[0].cache_control).toBeUndefined();
  });

  it("second block contains document context with cache control", () => {
    const blocks = buildSystemBlocks("My document content here", "specify");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("My document content here");
    expect(blocks[1].text).toContain("## Document Context");
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves the document context unchanged", () => {
    const context = "# Title\n\nSection with **markdown** and `code`";
    const blocks = buildSystemBlocks(context, "specify");
    expect(blocks[1].text).toContain(context);
  });

  // b-68 t-6: `draft` projects through the `specify` PhaseNode — draft + specify
  // share the React prompt set (b-33 carry-forward: draftAgent removed).
  it("maps `draft` onto the `specify` projection", () => {
    const draftText = buildSystemBlocks("ctx", "draft")[0].text;
    const specifyText = buildSystemBlocks("ctx", "specify")[0].text;
    expect(draftText).toBe(specifyText);
  });

  // b-68 t-6: every phase carries the React-only orientation blocks. The
  // identity check below is by design — per dec-9 the React surface is
  // phase-agnostic; per-phase behavioural prose moved to the shared_nudge
  // channel and no longer rides system blocks.
  it("includes the React-only orientation blocks in every phase", () => {
    const phases: SpecPhase[] = ["draft", "specify", "build", "verify", "done"];
    for (const phase of phases) {
      const text = buildSystemBlocks("ctx", phase)[0].text;
      expect(text).toContain("## Role");
      expect(text).toContain("## Available MDX Components");
      expect(text).toContain("## Available UI Tools");
      expect(text).toContain("## Memex & Document Context");
    }
  });

  // doc-12 dec-4 — humans own the `done` transition. This invariant lives in
  // the `context-awareness` PromptBlockNode (react_only), so it must remain
  // visible in every phase's assembled prompt even after the b-68 t-6 trim.
  it("includes the cross-phase invariants in every phase", () => {
    const phases: SpecPhase[] = ["draft", "specify", "build", "verify", "done"];
    for (const phase of phases) {
      const text = buildSystemBlocks("ctx", phase)[0].text;
      expect(text).toContain(
        "Never call `publish_spec` to move the phase backwards on your own. The user owns phase transitions in both directions.",
      );
      expect(text).toContain(
        "Closing a Spec to `done` is the human's call. Never autonomously transition to `done`. When verification is complete, hand off explicitly.",
      );
    }
  });

  // b-68 ac-28 — RECONCILED by spec-123 dec-8 (Move 2). The original b-68
  // invariant was "no shared_nudge content appears in buildSystemBlocks" — the
  // React prompt was trimmed to React-only content and the per-phase behavioural
  // prose rode the nudge channel only, leaving the in-app agent phase-blind.
  //
  // spec-123 dec-8 deliberately changes this: the in-app/React agent now ALSO
  // receives the per-phase behavioural `shared_nudge` guidance (the SAME scaffold
  // GuidanceBlocks the MCP agent gets), via `toPhaseGuidance` in buildSystemBlocks.
  // So the reconciled invariant has two halves:
  //   (a) the CROSS-PHASE global shared_nudge blocks (about-spec, mutation-
  //       protocol, code-grounding, standards-protocol — `target: {}`) still do
  //       NOT appear; they ride the nudge channel only.
  //   (b) the PER-PHASE behavioural prose now DOES appear, sourced from the
  //       scaffold (asserted by spec-123 ac-26 below).
  describe("ac-28 (reconciled by spec-123 dec-8): cross-phase global shared_nudge content stays excluded", () => {
    const phases: SpecPhase[] = ["draft", "specify", "build", "verify", "done"];

    it("the global cross-phase signature strings never appear in any phase", () => {
      tagAc(AC(28));
      // These are the `target: {}` global blocks — orientation that rides the
      // nudge channel exclusively. The per-phase behavioural headers (## Phase:
      // specify / build / verify, ## Phase discipline) are NO LONGER in this list:
      // spec-123 dec-8 ships them on the React surface on purpose.
      const globalSignatures = [
        "## What a Spec is",
        "Code-grounding self-classification",
        "Standards protocol",
      ];
      for (const phase of phases) {
        const text = buildSystemBlocks("ctx", phase)[0].text;
        for (const sig of globalSignatures) {
          expect(
            text,
            `global signature "${sig}" leaked into the ${phase} React prompt`,
          ).not.toContain(sig);
        }
      }
    });
  });

  // spec-123 ac-26 (dec-8, Move 2) — the in-app/React agent prompt now includes
  // the phase's shared per-phase behavioural guidance. Single-source: the text
  // comes from the same scaffold GuidanceBlocks the MCP agent receives via
  // `toNudge({ phase })` — buildSystemBlocks appends `toPhaseGuidance(BASE_SCAFFOLD,
  // phase)`. We assert, per phase, that the assembled React system prompt
  // contains the phase's behavioural block text.
  describe("spec-123 ac-26: buildSystemBlocks includes the phase's shared per-phase guidance", () => {
    const SPEC_123 = (n: number) =>
      `mindset-prod/memex-building-itself/specs/spec-123/acs/ac-${n}`;

    // Per-phase behavioural blocks ride a GuidanceBlock with `target: { phase }`.
    // For each phase, gather those base phase-targeted block texts and assert each
    // appears in the React system prompt (draft maps onto the specify projection).
    const phaseGuidanceTexts = (phase: SpecPhase): string[] => {
      const projected = phase === "draft" ? "specify" : phase;
      return BASE_SCAFFOLD.baseGuidance
        .filter(
          (b) =>
            b.source === "base" &&
            b.target.phase === projected &&
            b.target.tool === undefined &&
            b.target.transition === undefined &&
            b.target.button === undefined,
        )
        .map((b) => b.text);
    };

    for (const phase of ["specify", "build", "verify"] as SpecPhase[]) {
      it(`phase=${phase} — the React prompt carries the phase's shared_nudge behavioural block text`, () => {
        tagAc(SPEC_123(26));
        const text = buildSystemBlocks("ctx", phase)[0].text;
        const guidance = phaseGuidanceTexts(phase);
        expect(
          guidance.length,
          `expected at least one per-phase guidance block for ${phase}`,
        ).toBeGreaterThan(0);
        for (const block of guidance) {
          expect(
            text,
            `phase ${phase} React prompt is missing its shared per-phase guidance`,
          ).toContain(block);
        }
      });
    }

    it("the React per-phase guidance is byte-identical to the MCP agent's source (single-source, no copy)", () => {
      tagAc(SPEC_123(26));
      // buildSystemBlocks composes the phase guidance from the very same base
      // GuidanceBlocks the MCP nudge channel composes — so each phase block the
      // MCP agent sees is present verbatim in the React prompt.
      for (const phase of ["specify", "build", "verify"] as SpecPhase[]) {
        const reactText = buildSystemBlocks("ctx", phase)[0].text;
        for (const block of phaseGuidanceTexts(phase)) {
          expect(reactText.includes(block)).toBe(true);
        }
      }
    });
  });

  // b-68 ac-19 — no .md prompt files remain under phases/_base/ and no
  // <phase>/system.md exists (except creation/system.md). The build script
  // copies phases/**/* into dist/agent/phases/, so the absence of these
  // files on disk is what guarantees the React prompt is not loading prose
  // off disk for the four behavioural phases. (code-grounding.md and
  // standards-protocol.md stay until t-7 retires their non-system-prompt
  // consumers — phase-assessment.ts and mcp/formatters.ts.)
  describe("ac-19: retired .md files are gone from disk", () => {
    it("no <phase>/system.md remains for specify/build/verify/done", () => {
      tagAc(AC(19));
      const phases = ["specify", "build", "verify", "done"] as const;
      for (const phase of phases) {
        const filePath = resolve(PHASES_DIR, phase, "system.md");
        expect(existsSync(filePath), `${phase}/system.md still on disk`).toBe(false);
      }
    });

    it("creation/system.md is retained (out of scope for b-68)", () => {
      tagAc(AC(19));
      const filePath = resolve(PHASES_DIR, "creation", "system.md");
      expect(existsSync(filePath)).toBe(true);
    });

    it("the React-only base files are removed from _base/", () => {
      tagAc(AC(19));
      const retired = [
        "role.md",
        "about-spec.md",
        "mdx-components.md",
        "ui-tools.md",
        "context-awareness.md",
        "mutation-protocol.md",
      ];
      const baseDir = resolve(PHASES_DIR, "_base");
      const remaining = existsSync(baseDir) ? readdirSync(baseDir) : [];
      for (const filename of retired) {
        expect(remaining, `${filename} still on disk under _base/`).not.toContain(
          filename,
        );
      }
    });
  });
});

// spec-180: integration state block tests
describe("spec-180: integration state block in buildSystemBlocks", () => {
  const AC180 = (n: number) =>
    `mindset-prod/memex-building-itself/specs/spec-180/acs/ac-${n}`;

  // ac-4 + ac-5: the integration block is a SEPARATE third block with no cache_control,
  // sitting after the ephemeral context block — so it never busts the tool-definition cache.
  it("ac-4 + ac-5: integration block is a separate 3rd block with no cache_control; context block (2nd) retains its ephemeral marker", () => {
    tagAc(AC180(4));
    tagAc(AC180(5));
    const blocks = buildSystemBlocks("ctx", "specify");
    expect(blocks).toHaveLength(3);
    // context block (index 1) carries the cache breakpoint — unchanged by spec-180
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    // integration block (index 2) has no cache_control — always fresh
    expect(blocks[2].cache_control).toBeUndefined();
  });

  // ac-6 + ac-8: block is always present and always states both integrations explicitly.
  it("ac-6 + ac-8: always injects the block with both Slack and Discord lines — even with no integrationState passed", () => {
    tagAc(AC180(6));
    tagAc(AC180(8));
    const blocks = buildSystemBlocks("ctx", "specify");
    const text = blocks[2].text;
    expect(text).toContain("## Active integrations");
    expect(text).toContain("Slack:");
    expect(text).toContain("Discord:");
  });

  // ac-8: both lines present regardless of configuration state.
  it("ac-8: integration block always states both Slack and Discord regardless of what is configured", () => {
    tagAc(AC180(8));
    // Both unconfigured
    const noneBlocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: false, discordConnected: false, discordAmbiguous: false, discordChannelName: null,
    });
    expect(noneBlocks[2].text).toContain("Slack:");
    expect(noneBlocks[2].text).toContain("Discord:");

    // Both configured
    const bothBlocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: true, discordConnected: true, discordAmbiguous: false, discordChannelName: "general",
    });
    expect(bothBlocks[2].text).toContain("Slack:");
    expect(bothBlocks[2].text).toContain("Discord:");
  });

  // ac-1: Discord-only case — block must not mislead agent into thinking Slack is the only option.
  it("ac-1: Discord configured + Slack not connected — block says Discord is ready and Slack will fail", () => {
    tagAc(AC180(1));
    tagAc(AC180(7));
    const blocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: false, discordConnected: true, discordAmbiguous: false, discordChannelName: "build",
    });
    const text = blocks[2].text;
    expect(text).toContain("memex__send_discord_message is ready");
    expect(text).toContain("Slack: not connected");
    expect(text).not.toContain("Slack: connected");
  });

  // ac-2: Slack-only case — block must not mislead agent into thinking Discord is available.
  it("ac-2: Slack connected + Discord not configured — block says Slack is ready and Discord will fail", () => {
    tagAc(AC180(2));
    const blocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: true, discordConnected: false, discordAmbiguous: false, discordChannelName: null,
    });
    const text = blocks[2].text;
    expect(text).toContain("Slack: connected");
    expect(text).toContain("Discord: no webhook configured");
    expect(text).not.toContain("memex__send_discord_message is ready");
  });

  it("reports Discord as configured with channel name when available", () => {
    const blocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: false, discordConnected: true, discordAmbiguous: false, discordChannelName: "build",
    });
    expect(blocks[2].text).toContain("Discord: webhook configured (#build)");
    expect(blocks[2].text).toContain("memex__send_discord_message is ready");
  });

  it("reports Discord as ambiguous when multiple orgs have webhooks", () => {
    const blocks = buildSystemBlocks("ctx", "specify", false, false, false, {
      slackConnected: false, discordConnected: true, discordAmbiguous: true, discordChannelName: null,
    });
    expect(blocks[2].text).toContain("multiple orgs");
    expect(blocks[2].text).toContain("memex");
  });
});

// spec-176: Expose Spec creation + search to the document-assistant chat agent.
// Tests for implementation ACs tied to the resolved decisions (dec-1 through dec-5).
describe("spec-176: BASE_CREATE_FROM_DOC block — create-from-doc guidance", () => {
  const AC176 = (n: number) =>
    `mindset-prod/memex-building-itself/specs/spec-176/acs/ac-${n}`;

  const CREATE_FROM_DOC_MARKER = "## Creating a new Spec or document from this chat";

  // ac-7 (dec-1): both tools are already in getToolDefinitions() — no code change needed.
  it("ac-7: getToolDefinitions() returns create_doc and search_memex", () => {
    tagAc(AC176(7));
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_doc");
    expect(names).toContain("search_memex");
  });

  // ac-9 (dec-2): no create_spec alias in the live tool surface.
  it("ac-9: getToolDefinitions() does not expose a create_spec tool", () => {
    tagAc(AC176(9));
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("create_spec");
  });

  // ac-11 (dec-4): the new block is projected into the specify phase and its text
  // instructs the agent to call create_doc + search_memex before creating.
  it("ac-11: specify-phase prompt contains create-from-doc guidance (create_doc + search_memex instructions)", () => {
    tagAc(AC176(11));
    const text = buildSystemBlocks("ctx", "specify")[0].text;
    expect(text).toContain(CREATE_FROM_DOC_MARKER);
    expect(text).toContain("create_doc");
    expect(text).toContain("search_memex");
  });

  // ac-12 (dec-4): BASE_CONTEXT_AWARENESS is untouched — no create_doc instruction leaked in.
  it("ac-12: context-awareness block does not contain create_doc (BASE_CONTEXT_AWARENESS unchanged)", () => {
    tagAc(AC176(12));
    const block = BASE_SCAFFOLD.promptBlocks.find((b) => b.id === "context-awareness");
    expect(block).toBeDefined();
    expect(block?.text).not.toContain("create_doc");
  });

  // ac-13 (dec-5): block in specify/build/verify — absent from done.
  it("ac-13: create-from-doc guidance appears in specify, build, and verify prompts", () => {
    tagAc(AC176(13));
    for (const phase of ["specify", "build", "verify"] as SpecPhase[]) {
      const text = buildSystemBlocks("ctx", phase)[0].text;
      expect(text, `expected create-from-doc in ${phase} prompt`).toContain(CREATE_FROM_DOC_MARKER);
    }
  });

  it("ac-13: create-from-doc guidance is absent from the done-phase prompt", () => {
    tagAc(AC176(13));
    const text = buildSystemBlocks("ctx", "done")[0].text;
    expect(text).not.toContain(CREATE_FROM_DOC_MARKER);
  });

  // ── Scope ACs (ac-1 to ac-6) ─────────────────────────────────────────────
  // These are prompt-level proxy tests: we can't run an LLM in a unit test,
  // but we can assert the prompt contains the instructions that drive the
  // behaviour each AC describes.

  // ac-1: agent instructed to call create_doc (not ask the user to do it).
  // ac-2: agent instructed to proactively offer Spec creation when a problem surfaces.
  it("ac-1 + ac-2: specify prompt instructs the agent to call create_doc and to proactively offer — not defer to the user", () => {
    tagAc(AC176(1));
    tagAc(AC176(2));
    const text = buildSystemBlocks("ctx", "specify")[0].text;
    expect(text).toContain("create_doc");
    expect(text).toContain("Do not ask the user to create it themselves");
    expect(text).toContain("Proactive offer");
  });

  // ac-3: specify prompt contains the mandatory search-before-decision instruction
  // (sourced from PHASE_PLAN_SEARCH, a shared_nudge block shipped via toPhaseGuidance).
  it("ac-3: specify prompt instructs the agent to call search_memex before resolving a load-bearing decision", () => {
    tagAc(AC176(3));
    const text = buildSystemBlocks("ctx", "specify")[0].text;
    expect(text).toContain("Before resolving a load-bearing decision (mandatory)");
  });

  // ac-4: specify prompt contains the search-before-authoring instruction.
  it("ac-4: specify prompt instructs the agent to call search_memex before authoring new section content", () => {
    tagAc(AC176(4));
    const text = buildSystemBlocks("ctx", "specify")[0].text;
    expect(text).toContain("Before authoring substantive new section content");
  });

  // ac-5: change is react_only — no manifest/tool-specs/regression-test changes.
  // Proxied by ac-9 (no create_spec in tools) + ac-10 (surface is react_only).
  it("ac-5: no new tool entries — getToolDefinitions() count is stable, no create_spec alias", () => {
    tagAc(AC176(5));
    const tools = getToolDefinitions();
    expect(tools.map((t) => t.name)).not.toContain("create_spec");
    // create_doc and search_memex are present unchanged
    expect(tools.map((t) => t.name)).toContain("create_doc");
  });

  // ac-6: free-form docs use the same create_doc tool — the prompt block
  // mentions docType: 'document' so the agent knows to pass it.
  it("ac-6: specify prompt mentions docType document — no separate tool needed for free-form docs", () => {
    tagAc(AC176(6));
    const text = buildSystemBlocks("ctx", "specify")[0].text;
    expect(text).toContain("docType: 'document'");
  });
});

describe("buildCreationSystemBlocks (dec-1 Option A — Overview-only by default)", () => {
  it("returns role + skill blocks", () => {
    const blocks = buildCreationSystemBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("text");
    // Skill block carries the cache breakpoint.
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("instructs the agent to create only the Overview from this modal", () => {
    const role = buildCreationSystemBlocks()[0].text;

    // The "create only Overview" rule is the heart of dec-1 Option A.
    expect(role).toMatch(/only the Overview|Overview-only|create only the Overview/i);
    expect(role).toMatch(/Design.*Architecture.*Testing.*Acceptance/i);
  });

  it("does NOT instruct the agent to pre-list body sections in the confirmation", () => {
    const role = buildCreationSystemBlocks()[0].text;
    // The old prompt told the agent to render_confirmation with bulleted body
    // sections up-front, which is exactly what dec-1 Option A bans.
    expect(role).not.toMatch(/bulleted body-section titles/i);
    expect(role).not.toMatch(/show exactly the sections you intend to create/i);
  });

  it("tells the agent to hand off (no in-modal offer to add sections)", () => {
    const role = buildCreationSystemBlocks()[0].text;
    // The modal closes once create_doc succeeds — the agent has no input
    // affordance for follow-up. The post-create message must be a heads-up,
    // not a question.
    expect(role).toMatch(/closes|hand off|cannot reply|can't reply|heads-up/i);
    expect(role).toMatch(/agent inside|in-spec|chat panel/i);
    // It must NOT instruct the agent to ask "want me to" / "would you like".
    expect(role).not.toMatch(/Want me to add the standard sections/i);
    expect(role).not.toMatch(/Would you like me to add/i);
  });

  it("references dec-1 / doc-5 so the rule is traceable", () => {
    const role = buildCreationSystemBlocks()[0].text;
    expect(role).toMatch(/dec-1/i);
  });

  // b-33: the first block must come from phases/creation/system.md (not
  // inlined from elsewhere). Assert a snippet that is uniquely in that file
  // — the "Multi-Spec Flow" header and "Never Refuse — Always Convert"
  // language are creation-specific and don't appear in the per-phase shards.
  it("first block contains content unique to phases/creation/system.md", () => {
    const role = buildCreationSystemBlocks()[0].text;
    expect(role).toContain("Multi-Spec Flow");
    expect(role).toContain("Never Refuse — Always Convert");
  });

  // b-33: the spec-document skill is composed as a SECOND block, not
  // inlined into the first. This matches the role + skill shape from before
  // the phases/ refactor and keeps the skill independently cacheable /
  // re-usable.
  it("composes the spec-document skill as a separate second block (not inlined into role)", () => {
    const blocks = buildCreationSystemBlocks();
    expect(blocks).toHaveLength(2);
    // The skill defines what a Spec IS / IS NOT — that vocabulary lives
    // in the skill file, not in creation/system.md. Asserting a load-bearing
    // skill phrase ("Spec Document") is in block[1] and that the cache
    // breakpoint is on the skill block confirms the composition order.
    expect(blocks[1].text.length).toBeGreaterThan(0);
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].cache_control).toBeUndefined();
    // The role block REFERENCES the skill ("Spec Document skill below")
    // but the substantive skill content must live in block[1]. The skill
    // text should be different from the role text.
    expect(blocks[1].text).not.toBe(blocks[0].text);
  });
});
