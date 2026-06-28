import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// spec-371 t-5/t-6 — end-to-end of the planted hook SCRIPTS: real `node` runs of
// the two hooks, stdin in, behaviour out, against a throwaway HOME so nothing
// touches the real ~/.memex.
const NS = "mindset-prod/memex-building-itself/specs/spec-371/acs";
const AC_7 = `${NS}/ac-7`; // non-blocking, advisory only
const AC_9 = `${NS}/ac-9`; // claim_spec + phase-advance write the local marker
const AC_10 = `${NS}/ac-10`; // edit hook: outbound only when claimed; else no call
const AC_12 = `${NS}/ac-12`; // unclaim clears the marker
const AC_15 = `${NS}/ac-15`; // a single Claude Code plugin; no Cursor/Copilot adapter

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../plugin/hooks");
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "../plugin");

function run(script, payload, home) {
  return execFileSync("node", [join(HOOKS, script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "memex-e2e-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const markerOf = (home, sid) =>
  JSON.parse(readFileSync(join(home, ".memex", "checkouts", `${sid}.json`), "utf8"));
const markerExists = (home, sid) =>
  existsSync(join(home, ".memex", "checkouts", `${sid}.json`));

describe("spec-371 hooks e2e (ac-7, ac-9, ac-10, ac-12, ac-15)", () => {
  it("marker-write: claim_spec and a build-ward update_doc each write the marker; draft does not (ac-9)", () => {
    tagAc(AC_9);
    withHome((home) => {
      run("marker-write.mjs", {
        session_id: "claim",
        tool_name: "mcp__memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      expect(markerOf(home, "claim")).toMatchObject({ memex: "ns/m", spec: "spec-371" });

      run("marker-write.mjs", {
        session_id: "adv",
        tool_name: "mcp__memex__update_doc",
        tool_input: { ref: "ns/m/specs/spec-9", status: "build" },
      }, home);
      expect(markerOf(home, "adv")).toMatchObject({ spec: "spec-9" });

      run("marker-write.mjs", {
        session_id: "draft",
        tool_name: "mcp__memex__update_doc",
        tool_input: { ref: "ns/m/specs/spec-9", status: "draft" },
      }, home);
      expect(markerExists(home, "draft")).toBe(false); // not build-ward → no implicit checkout
    });
  });

  it("marker-write: unclaim_spec clears the marker (ac-12)", () => {
    tagAc(AC_12);
    withHome((home) => {
      run("marker-write.mjs", {
        session_id: "s",
        tool_name: "mcp__memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      expect(markerExists(home, "s")).toBe(true);
      run("marker-write.mjs", {
        session_id: "s",
        tool_name: "mcp__memex__unclaim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      expect(markerExists(home, "s")).toBe(false);
    });
  });

  it("edit hook: unclaimed → ONE advisory nudge, never a block; nothing leaves (ac-10, ac-7)", () => {
    tagAc(AC_10);
    tagAc(AC_7);
    withHome((home) => {
      const out = run("edit-phonehome.mjs", {
        session_id: "u",
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
      }, home);
      const parsed = JSON.parse(out);
      // advisory context injection — NOT a block/deny (non-blocking, ac-7)
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(/claim_spec/);
      expect(out).not.toMatch(/"decision"\s*:\s*"block"/);
      expect(out).not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
      // a second unclaimed edit is silent — no repeat nudge, still no network.
      const out2 = run("edit-phonehome.mjs", {
        session_id: "u",
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
      }, home);
      expect(out2.trim()).toBe("");
    });
  });

  it("edit hook: a claim with no key planted fails quiet — nothing leaves (ac-10)", () => {
    tagAc(AC_10);
    withHome((home) => {
      run("marker-write.mjs", {
        session_id: "c",
        tool_name: "mcp__memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      // claimed, but no ~/.memex/checkout.json and no env key → no phone-home, no output.
      const out = run("edit-phonehome.mjs", {
        session_id: "c",
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
        cwd: home,
      }, home);
      expect(out.trim()).toBe("");
    });
  });

  it("the plugin is a single Claude Code bundle — no Cursor/Windsurf/Copilot adapter (ac-15)", () => {
    tagAc(AC_15);
    const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8"));
    // Claude Code shape: PostToolUse matchers, no PreToolUse block path (non-blocking).
    expect(Array.isArray(hooks.hooks.PostToolUse)).toBe(true);
    expect(hooks.hooks.PreToolUse).toBeUndefined();
    // No per-vendor adapter files for other agents in v1.
    const names = readdirSync(PLUGIN).join(" ").toLowerCase();
    expect(names).not.toMatch(/cursor|windsurf|copilot/);
  });
});
