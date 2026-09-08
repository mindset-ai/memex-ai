// spec-551 t-1 (dec-5) — the enumeration of every string a reader actually receives.
//
// WHY THIS EXISTS. std-22 binds the portable surface: prose we author once that then
// runs against a codebase we cannot see. cl-32 and cl-35 name the surfaces by hand —
// scaffold prose, MCP tool descriptions, get_information bodies — and cl-60 records
// that enforcement was review-based, with no automated guard. Review then let eight
// bare-handle citations ship across four surfaces, one of which nobody had ever
// enumerated. This module is the walk those checks were missing.
//
// IT COLLECTS, IT DOES NOT JUDGE. `portability-scan.ts` owns the deny-list; this owns
// the corpus. The split is deliberate: two consumers ask different questions of the
// same strings — "is a handle cited here?" (spec-551) and "does every tool name in
// this prose still resolve?" (spec-511 t-1). One walk, two assertions. Two walks would
// drift apart the first time either is edited [per std-51], which is the same failure
// spec-545 refactored the deny-list to avoid.
//
// IT SITS BESIDE THE DENY-LIST rather than in a directory named for what it walks.
// The two halves of one guard are easier to keep honest together than apart; the
// directory name is inherited from the deny-list's first consumer, not a claim that
// scaffold prose is database code.
//
// THE FAILURE MODE TO DESIGN AGAINST is a rendered field that is silently skipped.
// The first inventory pass for this Spec keyed on property names and missed a bare
// exported constant carrying one of the defects. So the walk INCLUDES by default and
// excludes only a named list of fields that are never sent — the inverse of a walk
// that includes a named list and misses whatever is added next.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The scaffold module SPECIFICALLY, not the whole `@memex/shared` root.
//
// spec-551 t-2: an earlier version walked every export of the package and swept in
// registries whose descriptions are internal — `USAGE_EVENT_REGISTRY`'s analytics
// notes, for instance, which cite Specs and are read by us, never sent to anyone's
// Memex. Over-collection is not the safe direction it looks like: a guard that reds
// on correct strings gets switched off, and then it protects nothing.
//
// std-22 cl-32 names the file, so scoping to it follows the Standard rather than
// guessing. And the narrow corpus is COMPLETE rather than merely smaller, because
// std-15 makes this module the only permitted home for agent prompt prose — prose
// that reaches a reader cannot legitimately live anywhere else.
import * as scaffoldModule from "@memex/shared/scaffold-data";
import { toolSpecs } from "../agent/tool-specs.js";
import type { Scannable } from "./portability-scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUIDANCE_DIR = join(HERE, "..", "guidance");

// Scaffold fields that exist to explain the scaffold to US and are stripped before
// anything is sent: `rationale` is dropped explicitly by toToolDefinition, `notes`
// never leaves the dataset. Both are dense with entity handles BY DESIGN — they are
// the scaffold's own provenance. Scanning them would bury a real finding in hundreds
// of false ones, and a guard that cries wolf is a guard someone deletes.
//
// A field-shape rule, not a list of sites: a new node type inherits it for free.
const NEVER_RENDERED = new Set(["rationale", "notes"]);

/** Recursively collect every string reachable from a value, skipping metadata fields. */
function walk(value: unknown, path: string, out: Scannable[], seen: Set<object>): void {
  if (typeof value === "string") {
    out.push({ where: path, text: value });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_RENDERED.has(key)) continue;
    walk(child, `${path}.${key}`, out, seen);
  }
}

/**
 * Every rendered string in `@memex/shared` — the scaffold dataset AND the bare
 * exported prose constants beside it. Walking the whole module namespace rather than
 * a named list is the point: a constant added next month is walked without anyone
 * remembering to add it here.
 */
function collectScaffoldProse(): Scannable[] {
  const out: Scannable[] = [];
  const seen = new Set<object>();
  for (const [name, value] of Object.entries(scaffoldModule)) {
    if (typeof value === "function") continue;
    walk(value, `scaffold:${name}`, out, seen);
  }
  return out;
}

/**
 * The `get_information` topic bodies. Read from disk the way the server reads them,
 * so a topic added as a file is picked up without a registry to update.
 */
async function collectGuidanceProse(): Promise<Scannable[]> {
  const out: Scannable[] = [];
  const seen = new Set<object>();
  const files = (await readdir(GUIDANCE_DIR)).filter((f) => f.endsWith(".json"));
  for (const file of files.sort()) {
    const topic: unknown = JSON.parse(await readFile(join(GUIDANCE_DIR, file), "utf8"));
    walk(topic, `guidance:${file}`, out, seen);
  }
  return out;
}

/**
 * The live MCP contract: each registered tool's description, plus the per-argument
 * descriptions that ride the same JSON schema to the client.
 *
 * Sourced by importing the registry, never by reading the handler files as text. A
 * text scan would also see the comments above each tool — and this repo's comments
 * cite entity handles legitimately on almost every page, which would force exactly
 * the exemption list dec-3 rejected.
 */
function collectToolContractProse(): Scannable[] {
  const out: Scannable[] = [];
  for (const spec of toolSpecs) {
    out.push({ where: `tool:${spec.name} / description`, text: spec.description });
    if (spec.annotations?.title) {
      out.push({ where: `tool:${spec.name} / title`, text: spec.annotations.title });
    }
    for (const [arg, field] of Object.entries(spec.schema ?? {})) {
      // Zod exposes `.describe(...)` text on the type itself; a field with none
      // contributes nothing rather than an empty entry.
      const description = (field as { description?: unknown } | undefined)?.description;
      if (typeof description === "string" && description.length > 0) {
        out.push({ where: `tool:${spec.name} / arg:${arg}`, text: description });
      }
    }
  }
  return out;
}

/**
 * Every string this product renders to a reader in a Memex we do not control.
 *
 * The one export: callers bring their own assertion. Returns `Scannable` entries so
 * `scanForNonPortableTokens` consumes them directly, and each carries a `where` that
 * locates the string — a finding nobody can locate is a finding nobody acts on.
 */
export async function collectPortableSurface(): Promise<Scannable[]> {
  const guidance = await collectGuidanceProse();
  return [...collectScaffoldProse(), ...guidance, ...collectToolContractProse()];
}
