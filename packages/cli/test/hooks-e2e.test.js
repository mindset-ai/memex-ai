import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
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
const AC_16 = `${NS}/ac-16`; // no first-edit nudge; unchecked-out thread is silent
void AC_7; // (ac-7 now covered server-side by the gate test)

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
  it("marker-write: claim_spec + any successful spec mutation arm the marker; a collision-fail does not (ac-9)", () => {
    tagAc(AC_9);
    withHome((home) => {
      run("marker-write.mjs", {
        session_id: "claim",
        tool_name: "mcp__memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      expect(markerOf(home, "claim")).toMatchObject({ memex: "ns/m", spec: "spec-371" });

      // ANY successful spec mutation arms the thread — incl. a sub-entity edit
      // (resolves to its parent spec) and any update_doc (not just build-ward).
      run("marker-write.mjs", {
        session_id: "edit",
        tool_name: "mcp__memex__update_section",
        tool_input: { ref: "ns/m/specs/spec-9/sections/s-2" },
      }, home);
      expect(markerOf(home, "edit")).toMatchObject({ spec: "spec-9" });

      // A FAILED mutation (the gate's collision takeover) must NOT arm the thread.
      run("marker-write.mjs", {
        session_id: "blocked",
        tool_name: "mcp__memex__update_section",
        tool_input: { ref: "ns/m/specs/spec-9/sections/s-2" },
        tool_response: { isError: true },
      }, home);
      expect(markerExists(home, "blocked")).toBe(false);
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

  it("marker-write: arms the thread when the MCP tool is plugin-namespaced — the real install shape (ac-9)", () => {
    tagAc(AC_9);
    withHome((home) => {
      // When the Memex server ships inside the plugin, Claude Code names the tool
      // `mcp__plugin_memex-checkout_memex__claim_spec` — the exact name a real
      // install fires the hook with. The marker must still be written.
      run("marker-write.mjs", {
        session_id: "plug",
        tool_name: "mcp__plugin_memex-checkout_memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      expect(markerOf(home, "plug")).toMatchObject({ memex: "ns/m", spec: "spec-371" });
    });
  });

  it("edit hook: no checkout → SILENT — no steer, no network, nothing leaves (ac-10, ac-16)", () => {
    tagAc(AC_10);
    tagAc(AC_16);
    withHome((home) => {
      // An unchecked-out thread editing files emits NOTHING — the steer is gated off
      // by the same checkout marker, so there's no nudge and no network.
      const out = run("edit-phonehome.mjs", {
        session_id: "u",
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
      }, home);
      expect(out.trim()).toBe("");
      // and it never blocks/denies the edit.
      expect(out).not.toMatch(/"decision"\s*:\s*"block"/);
      expect(out).not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
    });
  });

  it("edit hook: a CHECKED-OUT edit emits the task-sync STEER (additionalContext), non-blocking, even with no key (the steer is local, key-independent) (ac-10)", () => {
    tagAc(AC_10);
    withHome((home) => {
      run("marker-write.mjs", {
        session_id: "c",
        tool_name: "mcp__memex__claim_spec",
        tool_input: { ref: "ns/m/specs/spec-371" },
      }, home);
      // No ~/.memex/checkout.json + no env key → the phone-home (network) is skipped,
      // but the STEER is emitted locally on stdout — it does not depend on the key.
      const out = run("edit-phonehome.mjs", {
        session_id: "c",
        tool_name: "Edit",
        tool_input: { file_path: "/x/y.ts" },
        cwd: home,
      }, home);
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain("spec-371");
      expect(ctx).toContain("update_task");
      expect(ctx).toContain("create_task");
      expect(ctx).toMatch(/no update is needed/i); // never forces a premature update
      // non-blocking: it never denies/blocks the edit.
      expect(out).not.toMatch(/"decision"\s*:\s*"block"/);
      expect(out).not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
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

// spec-430 dec-4 — the SessionStart self-heal guide.
const AC_9_430 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9";
// spec-300 dec-26 — the SessionStart skills attunement.
const AC_69 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-69";

function runSessionStart(home) {
  // Controlled env: clear the CI override so the file-state path is what's exercised.
  const env = { ...process.env, HOME: home };
  delete env.MEMEX_CHECKOUT_HOOK_KEY;
  delete env.MEMEX_CHECKOUT_API_BASE;
  return execFileSync("node", [join(HOOKS, "session-start-guide.mjs")], {
    input: JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" }),
    env,
    encoding: "utf8",
  });
}

describe("spec-430 SessionStart self-heal guide (ac-9)", () => {
  it("no checkout key → emits an additionalContext steer offering to finish setup", () => {
    tagAc(AC_9_430);
    withHome((home) => {
      const out = runSessionStart(home); // empty HOME, no ~/.memex/checkout.json
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(/memex-ai install/);
      // non-blocking: never denies/blocks.
      expect(out).not.toMatch(/"decision"\s*:\s*"block"/);
      expect(out).not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
    });
  });

  it("a stored hook_key → the self-heal setup steer is silent (no `memex-ai install` offer)", () => {
    tagAc(AC_9_430);
    withHome((home) => {
      mkdirSync(join(home, ".memex"), { recursive: true });
      writeFileSync(
        join(home, ".memex", "checkout.json"),
        JSON.stringify({ api_base: "https://memex.ai", hook_key: "mxh_present" }),
      );
      const out = runSessionStart(home);
      // spec-300 dec-26 changed this from fully-silent to "self-heal silent": the
      // install offer is gone once set up, but the skills attunement still rides.
      expect(out).not.toMatch(/memex-ai install/);
    });
  });
});

describe("spec-300 SessionStart skills attunement (ac-69)", () => {
  it("emits the cross-Memex skills guidance every session — set up OR not", () => {
    tagAc(AC_69);
    // Not set up: skills guidance rides alongside the setup steer.
    withHome((home) => {
      const parsed = JSON.parse(runSessionStart(home));
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toMatch(/all_memexes:true/);
      expect(ctx).toMatch(/list_skills/);
      expect(ctx).toMatch(/get_skill/);
      expect(ctx).toMatch(/memex-ai install/); // both concerns present when not set up
    });
    // Set up: skills guidance still present, self-heal steer gone.
    withHome((home) => {
      mkdirSync(join(home, ".memex"), { recursive: true });
      writeFileSync(
        join(home, ".memex", "checkout.json"),
        JSON.stringify({ hook_key: "mxh_present" }),
      );
      const parsed = JSON.parse(runSessionStart(home));
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toMatch(/all_memexes:true/);
      expect(ctx).toMatch(/list_skills/);
      expect(ctx).not.toMatch(/memex-ai install/);
    });
  });
});
