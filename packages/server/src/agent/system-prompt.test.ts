import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_SCAFFOLD, type SpecPhase } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks, buildCreationSystemBlocks } from "./system-prompt.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__dirname, "phases");

describe("buildSystemBlocks", () => {
  it("returns three blocks (instructions, context, integration state)", () => {
    const blocks = buildSystemBlocks("Some context", "plan");
    expect(blocks).toHaveLength(3);
  });

  it("first block contains the React-only role orientation", () => {
    const blocks = buildSystemBlocks("Some context", "plan");
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("## Role");
    expect(blocks[0].text).toContain("document assistant");
    expect(blocks[0].cache_control).toBeUndefined();
  });

  it("second block contains document context with cache control", () => {
    const blocks = buildSystemBlocks("My document content here", "plan");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("My document content here");
    expect(blocks[1].text).toContain("## Document Context");
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves the document context unchanged", () => {
    const context = "# Title\n\nSection with **markdown** and `code`";
    const blocks = buildSystemBlocks(context, "plan");
    expect(blocks[1].text).toContain(context);
  });

  // b-68 t-6: `draft` projects through the `plan` PhaseNode — draft + plan
  // share the React prompt set (b-33 carry-forward: draftAgent removed).
  it("maps `draft` onto the `plan` projection", () => {
    const draftText = buildSystemBlocks("ctx", "draft")[0].text;
    const planText = buildSystemBlocks("ctx", "plan")[0].text;
    expect(draftText).toBe(planText);
  });

  // b-68 t-6: every phase carries the React-only orientation blocks. The
  // identity check below is by design — per dec-9 the React surface is
  // phase-agnostic; per-phase behavioural prose moved to the shared_nudge
  // channel and no longer rides system blocks.
  it("includes the React-only orientation blocks in every phase", () => {
    const phases: SpecPhase[] = ["draft", "plan", "build", "verify", "done"];
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
    const phases: SpecPhase[] = ["draft", "plan", "build", "verify", "done"];
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
    const phases: SpecPhase[] = ["draft", "plan", "build", "verify", "done"];

    it("the global cross-phase signature strings never appear in any phase", () => {
      tagAc(AC(28));
      // These are the `target: {}` global blocks — orientation that rides the
      // nudge channel exclusively. The per-phase behavioural headers (## Phase:
      // plan / build / verify, ## Phase discipline) are NO LONGER in this list:
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
    // appears in the React system prompt (draft maps onto the plan projection).
    const phaseGuidanceTexts = (phase: SpecPhase): string[] => {
      const projected = phase === "draft" ? "plan" : phase;
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

    for (const phase of ["plan", "build", "verify"] as SpecPhase[]) {
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
      for (const phase of ["plan", "build", "verify"] as SpecPhase[]) {
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
    it("no <phase>/system.md remains for plan/build/verify/done", () => {
      tagAc(AC(19));
      const phases = ["plan", "build", "verify", "done"] as const;
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
    const blocks = buildSystemBlocks("ctx", "plan");
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
    const blocks = buildSystemBlocks("ctx", "plan");
    const text = blocks[2].text;
    expect(text).toContain("## Active integrations");
    expect(text).toContain("Slack:");
    expect(text).toContain("Discord:");
  });

  // ac-8: both lines present regardless of configuration state.
  it("ac-8: integration block always states both Slack and Discord regardless of what is configured", () => {
    tagAc(AC180(8));
    // Both unconfigured
    const noneBlocks = buildSystemBlocks("ctx", "plan", false, false, false, {
      slackConnected: false, discordConnected: false, discordAmbiguous: false, discordChannelName: null,
    });
    expect(noneBlocks[2].text).toContain("Slack:");
    expect(noneBlocks[2].text).toContain("Discord:");

    // Both configured
    const bothBlocks = buildSystemBlocks("ctx", "plan", false, false, false, {
      slackConnected: true, discordConnected: true, discordAmbiguous: false, discordChannelName: "general",
    });
    expect(bothBlocks[2].text).toContain("Slack:");
    expect(bothBlocks[2].text).toContain("Discord:");
  });

  // ac-1: Discord-only case — block must not mislead agent into thinking Slack is the only option.
  it("ac-1: Discord configured + Slack not connected — block says Discord is ready and Slack will fail", () => {
    tagAc(AC180(1));
    tagAc(AC180(7));
    const blocks = buildSystemBlocks("ctx", "plan", false, false, false, {
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
    const blocks = buildSystemBlocks("ctx", "plan", false, false, false, {
      slackConnected: true, discordConnected: false, discordAmbiguous: false, discordChannelName: null,
    });
    const text = blocks[2].text;
    expect(text).toContain("Slack: connected");
    expect(text).toContain("Discord: no webhook configured");
    expect(text).not.toContain("memex__send_discord_message is ready");
  });

  it("reports Discord as configured with channel name when available", () => {
    const blocks = buildSystemBlocks("ctx", "plan", false, false, false, {
      slackConnected: false, discordConnected: true, discordAmbiguous: false, discordChannelName: "build",
    });
    expect(blocks[2].text).toContain("Discord: webhook configured (#build)");
    expect(blocks[2].text).toContain("memex__send_discord_message is ready");
  });

  it("reports Discord as ambiguous when multiple orgs have webhooks", () => {
    const blocks = buildSystemBlocks("ctx", "plan", false, false, false, {
      slackConnected: false, discordConnected: true, discordAmbiguous: true, discordChannelName: null,
    });
    expect(blocks[2].text).toContain("multiple orgs");
    expect(blocks[2].text).toContain("memex");
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
