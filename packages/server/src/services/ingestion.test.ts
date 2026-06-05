import { describe, expect, it } from "vitest";
import { allowedIngestRoots, assertPathsAllowed } from "./ingestion.js";

describe("allowedIngestRoots", () => {
  it("returns [] when env is unset or empty", () => {
    expect(allowedIngestRoots(undefined)).toEqual([]);
    expect(allowedIngestRoots("")).toEqual([]);
    expect(allowedIngestRoots("   ")).toEqual([]);
  });

  it("splits on ':' and trims whitespace", () => {
    expect(allowedIngestRoots("/a/b : /c/d")).toEqual(["/a/b", "/c/d"]);
  });

  it("resolves paths to absolute canonical form", () => {
    // Paths are passed to path.resolve so relatives become absolute.
    expect(allowedIngestRoots("/absolute/path")).toEqual(["/absolute/path"]);
  });
});

describe("assertPathsAllowed", () => {
  const roots = "/workspaces:/home/dev/repos";

  it("throws when ALLOWED_INGEST_ROOTS is not configured (fail-closed)", () => {
    // Security-critical: unset env MUST reject every request, not default-allow.
    expect(() => assertPathsAllowed(["/anything"], undefined, identityRealpath)).toThrow(
      /ALLOWED_INGEST_ROOTS is not configured/,
    );
    expect(() => assertPathsAllowed(["/anything"], "", identityRealpath)).toThrow(
      /ALLOWED_INGEST_ROOTS is not configured/,
    );
  });

  it("accepts a path that is exactly a root", () => {
    expect(() =>
      assertPathsAllowed(["/workspaces"], roots, identityRealpath),
    ).not.toThrow();
  });

  it("accepts a path inside a root", () => {
    expect(() =>
      assertPathsAllowed(["/workspaces/my-repo"], roots, identityRealpath),
    ).not.toThrow();
    expect(() =>
      assertPathsAllowed(
        ["/workspaces/my-repo/packages/server"],
        roots,
        identityRealpath,
      ),
    ).not.toThrow();
  });

  it("rejects a path outside every root", () => {
    // The core threat: an agent-supplied `/etc/passwd` or `/root/.ssh`
    // must be denied before any subprocess spawns.
    expect(() =>
      assertPathsAllowed(["/etc/nginx"], roots, identityRealpath),
    ).toThrow(/is outside ALLOWED_INGEST_ROOTS/);
    expect(() =>
      assertPathsAllowed(["/root/.ssh"], roots, identityRealpath),
    ).toThrow(/is outside ALLOWED_INGEST_ROOTS/);
  });

  it("rejects a path that is a prefix-overlap but not a subdirectory", () => {
    // `/workspacesXYZ` happens to start with `/workspaces` but is not
    // actually under it. The check adds path.sep to avoid this trap.
    expect(() =>
      assertPathsAllowed(["/workspacesXYZ/thing"], roots, identityRealpath),
    ).toThrow(/is outside ALLOWED_INGEST_ROOTS/);
  });

  it("follows symlinks: canonicalises via realpath before checking", () => {
    // A symlink at /allowed/link → /etc should be REJECTED, not accepted.
    // The gate must use realpath to canonicalise, then check the canonical
    // path against the allow-list. Simulated by making realpath return /etc
    // when the caller passed /workspaces/malicious-link.
    const symlinkRealpath = (p: string) => {
      if (p === "/workspaces/malicious-link") return "/etc";
      return p;
    };
    expect(() =>
      assertPathsAllowed(["/workspaces/malicious-link"], roots, symlinkRealpath),
    ).toThrow(/resolved to \/etc/);
  });

  it("rejects paths that don't exist (realpath throws)", () => {
    const failingRealpath = (_: string) => {
      throw new Error("ENOENT");
    };
    expect(() =>
      assertPathsAllowed(["/nonexistent"], roots, failingRealpath),
    ).toThrow(/does not exist or is unreadable/);
  });

  it("requires every path in a multi-path request to pass", () => {
    expect(() =>
      assertPathsAllowed(
        ["/workspaces/ok", "/etc/evil"],
        roots,
        identityRealpath,
      ),
    ).toThrow(/is outside/);
  });
});

// identity: realpath returns the input unchanged, which matches the common
// case (no symlinks). Tests that need symlink behaviour inject their own.
function identityRealpath(p: string): string {
  return p;
}
