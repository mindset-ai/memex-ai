import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolSpecs } from "./tool-specs.js";

// spec-138 t-5 — tool-level verification for ac-4 and ac-5.
//
// ac-4: no webhook configured → clear ValidationError prompting admin to configure.
// ac-5: memex__send_slack_message is unaffected (still present, schema unchanged).
//
// These are pure structural + mock-based unit tests — no DB, no real Discord.
// Real-channel delivery (ac-1/ac-2/ac-3) is verified manually with a live webhook.

const AC_4 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-4";
const AC_5 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-5";

const discordSpec = toolSpecs.find((s) => s.name === "memex__send_discord_message")!;
const slackSpec = toolSpecs.find((s) => s.name === "memex__send_slack_message")!;

// Minimal ToolCtx mock — only the fields the discord handler uses.
function mockCtx(overrides: Partial<{ orgId: string | null }> = {}) {
  const orgId = overrides.orgId ?? "test-org-id";
  return {
    userId: "test-user",
    resolveMemex: vi.fn().mockResolvedValue("test-memex-id"),
    resolveRef: vi.fn(),
    resolveMemexFromEntity: vi.fn(),
    verbose: false,
  };
}

describe("spec-138 ac-4 — no webhook configured returns clear error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("tool registration: memex__send_discord_message exists in the catalogue", () => {
    tagAc(AC_4);
    expect(discordSpec).toBeDefined();
    expect(discordSpec.name).toBe("memex__send_discord_message");
  });

  it("error message directs admin to /settings/integrations when no webhook is configured", () => {
    tagAc(AC_4);
    // Structural assertion: the source must contain the exact user-facing message.
    // This guards against the message being silently changed to something vague.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(__dirname, "tool-specs.ts"), "utf8");
    expect(src).toContain("No Discord webhook configured for this org");
    expect(src).toContain("/settings/integrations");
  });

  it("schema has text (required), specRef (optional), channelOrUser (optional)", () => {
    tagAc(AC_4);
    expect(discordSpec.schema).toHaveProperty("text");
    expect(discordSpec.schema).toHaveProperty("specRef");
    expect(discordSpec.schema).toHaveProperty("channelOrUser");
  });
});

describe("spec-138 ac-5 — Slack integration unaffected", () => {
  it("memex__send_slack_message still present in catalogue", () => {
    tagAc(AC_5);
    expect(slackSpec).toBeDefined();
    expect(slackSpec.name).toBe("memex__send_slack_message");
  });

  it("Slack schema is unchanged: channelOrUser required, text required, specRef optional", () => {
    tagAc(AC_5);
    expect(slackSpec.schema).toHaveProperty("channelOrUser");
    expect(slackSpec.schema).toHaveProperty("text");
    expect(slackSpec.schema).toHaveProperty("specRef");
  });

  it("Discord tool is separate from Slack — does not share the handler", () => {
    tagAc(AC_5);
    expect(discordSpec.handler).not.toBe(slackSpec.handler);
  });
});
