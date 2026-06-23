import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomainLogger } from "./domain-logger.js";

describe("createDomainLogger (std-14)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.DEBUG_TESTDOMAIN;
  });

  it("is enabled by default (no DEBUG_<DOMAIN> set) and writes a std-14 block to console", () => {
    delete process.env.DEBUG_TESTDOMAIN;
    const log = createDomainLogger("testdomain");
    expect(log.enabled).toBe(true);

    log.block("mint", "minted token", "userId=u_123\nscope=read");

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const out = consoleSpy.mock.calls[0]?.[0] as string;
    // Block framing per std-14 cl-7.
    expect(out).toContain("┌─ [TESTDOMAIN mint]");
    expect(out).toContain("— minted token");
    expect(out).toContain("│ userId=u_123");
    expect(out).toContain("│ scope=read");
    expect(out).toContain("└─ (end mint)");
  });

  it("is silenced by DEBUG_<DOMAIN>=0 (cl-10/cl-11) — no console write, enabled=false", () => {
    process.env.DEBUG_TESTDOMAIN = "0";
    const log = createDomainLogger("testdomain");
    expect(log.enabled).toBe(false);

    log.block("mint", "should not appear");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("derives the env var from the domain slug (DEBUG_<UPPER>)", () => {
    process.env.DEBUG_TESTDOMAIN = "0";
    // A different domain is unaffected by another domain's flag.
    const other = createDomainLogger("otherdomain");
    expect(other.enabled).toBe(true);
  });
});
