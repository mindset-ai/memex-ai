import { describe, it, expect } from "vitest";
import { parseArgs, DEFAULT_API_BASE } from "../lib/argv.js";

// Build a full argv the way Node.js does — position 0 = node binary, 1 = script.
// parseArgs ignores both, but passing them makes the tests self-documenting.
function argv(...flags) {
  return ["node", "cli.mjs", ...flags];
}

describe("parseArgs", () => {
  it("defaults to install with the prod API base", () => {
    expect(parseArgs(argv())).toEqual({
      command: "install",
      apiBase: DEFAULT_API_BASE,
      adminBase: null,
      label: null,
      yes: false,
      help: false,
      skipBrowser: false,
    });
  });

  it("recognises the explicit install subcommand", () => {
    expect(parseArgs(argv("install")).command).toBe("install");
  });

  it("recognises `uninstall` as a subcommand and as --uninstall", () => {
    expect(parseArgs(argv("uninstall")).command).toBe("uninstall");
    expect(parseArgs(argv("--uninstall")).command).toBe("uninstall");
  });

  it("parses --help and -h", () => {
    expect(parseArgs(argv("--help")).help).toBe(true);
    expect(parseArgs(argv("-h")).help).toBe(true);
  });

  it("parses --yes and -y", () => {
    expect(parseArgs(argv("--yes")).yes).toBe(true);
    expect(parseArgs(argv("-y")).yes).toBe(true);
  });

  it("parses --api-base with a custom URL", () => {
    const result = parseArgs(argv("--api-base", "http://localhost:8080"));
    expect(result.apiBase).toBe("http://localhost:8080");
  });

  it("parses --label with a device name", () => {
    expect(parseArgs(argv("--label", "work-laptop")).label).toBe(
      "work-laptop"
    );
  });

  it("parses --no-browser", () => {
    expect(parseArgs(argv("--no-browser")).skipBrowser).toBe(true);
  });

  it("handles multiple flags in one invocation", () => {
    const result = parseArgs(
      argv("--yes", "--no-browser", "--api-base", "http://x", "--label", "lap")
    );
    expect(result).toMatchObject({
      yes: true,
      skipBrowser: true,
      apiBase: "http://x",
      label: "lap",
    });
  });

  it("silently ignores unknown flags (preserves existing behaviour)", () => {
    // The shipping CLI does not fail on unknown flags — changing that would be a
    // behaviour change. Lock the current tolerance down with a test so any future
    // change is explicit.
    const result = parseArgs(argv("--unknown-flag"));
    expect(result.command).toBe("install");
  });
});
