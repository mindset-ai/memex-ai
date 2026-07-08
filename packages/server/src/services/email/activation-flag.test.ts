// spec-427 t-6 (ac-16) — the ACTIVATION_EMAILS_ENABLED master/kill switch. Default OFF;
// on only for explicit truthy values; read live so a flip takes effect immediately.
import { describe, it, expect, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { activationEmailsEnabled } from "./activation-flag.js";

const AC16 = "mindset-prod/memex-building-itself/specs/spec-427/acs/ac-16";
const saved = process.env.ACTIVATION_EMAILS_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.ACTIVATION_EMAILS_ENABLED;
  else process.env.ACTIVATION_EMAILS_ENABLED = saved;
});

describe("activationEmailsEnabled", () => {
  it("defaults OFF when unset (the safe default — the backlog never fires by accident)", () => {
    tagAc(AC16);
    delete process.env.ACTIVATION_EMAILS_ENABLED;
    expect(activationEmailsEnabled()).toBe(false);
  });

  it("is OFF for empty / falsey / unrecognised values", () => {
    tagAc(AC16);
    for (const v of ["", " ", "0", "false", "no", "off", "enabled", "prod"]) {
      process.env.ACTIVATION_EMAILS_ENABLED = v;
      expect(activationEmailsEnabled(), `"${v}" should be off`).toBe(false);
    }
  });

  it("is ON only for explicit truthy values (case-insensitive)", () => {
    tagAc(AC16);
    for (const v of ["1", "true", "TRUE", "yes", "On"]) {
      process.env.ACTIVATION_EMAILS_ENABLED = v;
      expect(activationEmailsEnabled(), `"${v}" should be on`).toBe(true);
    }
  });

  it("reads live — a flip to off takes effect on the next call (kill switch)", () => {
    tagAc(AC16);
    process.env.ACTIVATION_EMAILS_ENABLED = "1";
    expect(activationEmailsEnabled()).toBe(true);
    process.env.ACTIVATION_EMAILS_ENABLED = "0";
    expect(activationEmailsEnabled()).toBe(false);
  });
});
