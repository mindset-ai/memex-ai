// spec-203 ac-14/ac-15/ac-16/ac-17 — the footer has ONE seat of intelligence.
//
// A tool call is the client phoning home; the server returns the real result,
// then uses that one opening to steer the client through guidance authored in a
// SINGLE place (`composeGuidanceEnvelope`, spec-219) and attached at a SINGLE
// choke point (`runToolWithSpecTraffic`), on EVERY Spec-resolving call. Source-text guards
// (no DB) pin the wiring so a future refactor cannot re-introduce a second footer
// author or re-gate persistence. The behavioural proof (footer rides terse +
// persisted) lives in services/spec-203-footer.integration.test.ts.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(SERVER_ROOT, "src", p), "utf-8");

const formatters = read(join("mcp", "formatters.ts"));
const toolSpecs = read(join("agent", "tool-specs.ts"));
const specTraffic = read(join("services", "spec-traffic.ts"));
const telemetry = read(join("services", "mcp-telemetry.ts"));

describe("ac-15 — one seat: the footer is composed in exactly one place", () => {
  it("formatFullDocState no longer composes a footer (the body carries none)", () => {
    tagAc(AC(15));
    // The body renderer must not author a footer of its own.
    expect(formatters).toMatch(/the footer is NO LONGER composed here/i);
    // The only footer composer (`formatSpecGuidance`) is the seat's helper, not
    // called from inside the body renderer.
    const bodyFn = formatters.slice(
      formatters.indexOf("export function formatFullDocState"),
      formatters.indexOf("// Document List"),
    );
    expect(bodyFn).not.toMatch(/lines\.push\(formatSpecGuidance\(/);
  });

  it("composeGuidanceEnvelope is the single seat that authors guidance content", () => {
    tagAc(AC(15));
    tagAc(AC(16));
    expect(toolSpecs).toMatch(/export async function composeGuidanceEnvelope\(/);
    // Sole author: nothing else in spec-traffic composes a footer; it only calls
    // the seat.
    expect(specTraffic).toMatch(/const \{ composeGuidanceEnvelope \} = await import/);
  });
});

describe("ac-14 / ac-16 — the seat is invoked at the one choke point, every call", () => {
  it("runToolWithSpecTraffic attaches the seat's footer for every resolved Spec", () => {
    tagAc(AC(14));
    tagAc(AC(16));
    expect(specTraffic).toMatch(/composeGuidanceEnvelope\(/);
    // The choke point owns the single delimiter, assembling header + body +
    // FOOTER_DELIMITER + footer (spec-219 ac-7).
    expect(specTraffic).toMatch(/\$\{FOOTER_DELIMITER\}\\n\$\{footer\}/);
    // Only when a Spec resolved, and only when no footer is already present
    // (defence-in-depth — the body composes none).
    expect(specTraffic).toMatch(/if \(target && !text\.includes\(FOOTER_DELIMITER\)\)/);
  });

  it("the seat branches on verbose internally — one method, not two paths", () => {
    tagAc(AC(16));
    const seat = toolSpecs.slice(
      toolSpecs.indexOf("export async function composeGuidanceEnvelope("),
      toolSpecs.indexOf("async function craftUntestedAcNag("),
    );
    expect(seat).toMatch(/if \(ctx\.verbose\)/); // full footer on reads
    expect(seat).toMatch(/toHandoffEssence/); // lean essence on terse
  });
});

describe("ac-17 — footer emitted ⇒ footer persisted (ungated)", () => {
  it("the footer is split off the result and persisted, NOT gated by isDevMode", () => {
    tagAc(AC(17));
    expect(telemetry).toMatch(/splitToolResult\(input\.resultText\)\.footer/);
    expect(telemetry).toMatch(/NOT gated by isDevMode/);
    const footerLine = telemetry
      .split("\n")
      .find((l) => l.includes("splitToolResult(input.resultText).footer"));
    expect(footerLine).toBeTruthy();
    expect(footerLine).not.toMatch(/isDevMode/);
  });
});
