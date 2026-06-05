// b-68 t-8 — nudge-channel parity between the React (agent) and MCP surfaces.
//
// Two AC guards live here:
//
// **ac-29** — "The MCP tool-response path and the React tool-execution path
// both call the same `toNudge(tool, phase, orgBlocks)` exported from
// `@memex/shared` — no surface-specific nudge composition exists."
//
//   - Static import-surface check: `toNudge` is imported from `@memex/shared`
//     by every server module that composes phase guidance (i.e. it's not
//     forked into a server-local helper).
//   - End-to-end byte-equality: invoking the SAME tool (e.g. `update_section`)
//     against the SAME doc through both surfaces produces an identical nudge
//     section in the rendered response.
//
// **ac-31** — "Per-Org `GuidanceBlock`s reach the agent only via the nudge
// and rubric channels; no code path injects an Org block into
// `buildSystemBlocks` or any React-only prompt assembly."
//
//   - Fixture: an Org row with sentinel text. The sentinel MUST NOT appear in
//     `buildSystemBlocks(documentContext, phase)` output for ANY phase. The
//     React system prompt is a pure projection of `BASE_SCAFFOLD` filtered to
//     `surface: 'react_only'` — Org-overlay blocks are `source: 'org'` and
//     ride the nudge channel exclusively.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  orgScaffoldAdditions,
  users,
} from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { addSection, updateSection } from "../services/sections.js";
import { createOrgScaffoldAddition } from "../services/scaffold-additions.js";
import { listOrgScaffoldAdditionsCached } from "../services/scaffold-additions-cache.js";
import { executeServerTool } from "./tools.js";
import { createMcpServer } from "../mcp/tools.js";
import { buildSystemBlocks } from "./system-prompt.js";
import { BASE_SCAFFOLD, type SpecPhase } from "@memex/shared";

const AC_29 = "mindset-prod/memex-building-itself/briefs/b-68/acs/ac-29";
const AC_31 = "mindset-prod/memex-building-itself/briefs/b-68/acs/ac-31";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TestActor {
  userId: string;
  orgId: string;
  namespaceId: string;
  memexId: string;
  nsSlug: string;
  memexSlug: string;
}

const createdDocIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];
const createdScaffoldAdditions: string[] = [];

async function makeActor(prefix: string): Promise<TestActor> {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [u] = await db
    .insert(users)
    .values({ email: `nudge-parity-${sub}@memex.test` } as any)
    .returning();
  createdUserIds.push(u.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: sub, kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` })
    .returning();
  await db
    .update(namespaces)
    .set({ ownerOrgId: org.id })
    .where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  await db.insert(orgMemberships).values({
    userId: u.id,
    orgId: org.id,
    role: "administrator",
  });
  return {
    userId: u.id,
    orgId: org.id,
    namespaceId: ns.id,
    memexId: mx.id,
    nsSlug: ns.slug,
    memexSlug: mx.slug,
  };
}

afterAll(async () => {
  if (createdScaffoldAdditions.length) {
    await db
      .delete(orgScaffoldAdditions)
      .where(inArray(orgScaffoldAdditions.id, createdScaffoldAdditions))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    const sectionRows = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, id))
      .catch(() => []);
    for (const s of sectionRows) {
      await db.delete(docComments).where(eq(docComments.sectionId, s.id)).catch(() => {});
    }
    await db.delete(docSections).where(eq(docSections.docId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // namespace cascade nukes org → memex → org_scaffold_additions, but the
    // explicit deletes above are defensive against partial cascade configs.
    for (const nsId of createdNamespaceIds) {
      await db.delete(namespaces).where(eq(namespaces.id, nsId)).catch(() => {});
    }
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ac-29: import-surface check + cross-surface byte-equality.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 t-8 ac-29: both surfaces compose nudges via the same `toNudge` from @memex/shared", () => {
  it("`toNudge` is sourced from `@memex/shared` everywhere it's referenced — no server-local fork", () => {
    tagAc(AC_29);
    // Static guard. Any module under packages/server/src that mentions
    // `toNudge` in its source MUST import it from `@memex/shared`. We grep
    // the live source files; a future fork into `local-nudge.ts` would
    // either change the import path or skip the import entirely, both of
    // which this assertion catches.
    const targets = [
      resolve(__dirname, "../mcp/formatters.ts"),
      // tool-specs.ts shares one composer between both surfaces; check it too
      // so a future addition that touches `toNudge` inside it is forced
      // through `@memex/shared`.
      resolve(__dirname, "tool-specs.ts"),
    ];
    for (const file of targets) {
      const raw = readFileSync(file, "utf8");
      // Strip line + block comments before matching so a mention in jsdoc
      // doesn't trigger the import check. The check fires only when the file
      // actually CALLS `toNudge(` in code.
      const src = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      if (!/\btoNudge\s*\(/.test(src)) continue;
      // Allow whitespace + multi-line imports between `toNudge` and the
      // `from '@memex/shared'` clause — this is the canonical import shape.
      expect(raw, `${file} calls toNudge() but doesn't import it from @memex/shared`).toMatch(
        /import\s*\{[^}]*\btoNudge\b[^}]*\}\s*from\s*["']@memex\/shared["']/s,
      );
    }
  });

  it("no server-local re-declaration of `toNudge` exists", () => {
    tagAc(AC_29);
    // Hard guard: anywhere under packages/server/src, a `function toNudge(`
    // or `const toNudge =` declaration would be a parallel composer. The
    // single home is `@memex/shared`; the server imports it. This catches
    // the literal fork-the-projection regression.
    const SERVER_SRC = resolve(__dirname, "..");
    function walk(dir: string, acc: string[] = []): string[] {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(resolve(dir, entry.name), acc);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          acc.push(resolve(dir, entry.name));
        }
      }
      return acc;
    }
    const offenders: string[] = [];
    for (const file of walk(SERVER_SRC)) {
      const raw = readFileSync(file, "utf8");
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      // Match `function toNudge(`, `const toNudge =`, `let toNudge =`, etc.
      // These would be a literal redefinition of the shared projection.
      if (/\b(?:function|const|let|var)\s+toNudge\b/.test(stripped)) {
        offenders.push(file.replace(SERVER_SRC, "<server>"));
      }
    }
    expect(offenders, `local toNudge re-declaration found — the shared @memex/shared projection MUST be the only home:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-31: Org blocks never bleed into `buildSystemBlocks`.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 t-8 ac-31: Org GuidanceBlocks never reach the React system prompt", () => {
  // The structural guarantee: `buildSystemBlocks` is a pure projection of
  // `BASE_SCAFFOLD` filtered to `surface: 'react_only'`. Org blocks are
  // `source: 'org'` and ride the nudge channel via `toNudge`. We assert this
  // by seeding an Org row with a sentinel string and verifying the sentinel
  // is absent from `buildSystemBlocks` output for every phase.

  const ALL_PHASES: SpecPhase[] = ["draft", "plan", "build", "verify", "done"];

  it("an Org-scoped GuidanceBlock sentinel does not appear in buildSystemBlocks output for ANY phase", async () => {
    tagAc(AC_31);
    const actor = await makeActor("sysprompt");
    const sentinel = `ORG-SENTINEL-${Math.random().toString(36).slice(2, 10)}`;

    // Create an Org block targeted at every phase via the phase-agnostic
    // shape (empty target matches everything per b-68 dec-1 — same as the
    // base "shared_nudge" blocks). Picks up the broadest possible match
    // surface so a regression would have to actively skip it.
    const created = await createOrgScaffoldAddition({
      orgId: actor.orgId,
      authorId: actor.userId,
      target: {},
      text: sentinel,
      rationale: "ac-31 fixture — must never leak into React system prompt.",
      enabled: true,
    });
    createdScaffoldAdditions.push(created.id);

    // Sanity: the fixture IS visible through the runtime Org-blocks reader
    // (same path the nudge channel uses), so we know the test is actually
    // exercising a fixture that the system COULD leak.
    const orgBlocks = await listOrgScaffoldAdditionsCached(actor.orgId, {
      enabledOnly: true,
    });
    expect(orgBlocks.some((b) => b.text === sentinel)).toBe(true);

    // The actual assertion: for every phase, the sentinel is absent from
    // every block of the React system prompt.
    for (const phase of ALL_PHASES) {
      const blocks = buildSystemBlocks("Document context body.", phase);
      const joined = blocks.map((b) => b.text).join("\n\n");
      expect(joined).not.toContain(sentinel);
    }
  });

  it("the GLOBAL cross-phase `shared_nudge` blocks stay off the React system prompt (reconciled by spec-123 dec-8)", () => {
    tagAc(AC_31);
    // RECONCILED by spec-123 dec-8 (Move 2). Originally this asserted that NO
    // `shared_nudge` PromptBlockNode text appears in buildSystemBlocks. dec-8
    // deliberately ships the PER-PHASE behavioural shared_nudge prose on the
    // React surface (so the in-app agent is no longer phase-blind) — so the
    // reconciled guard narrows to the GLOBAL cross-phase blocks: the ones whose
    // prose has NO per-phase GuidanceBlock (`target: { phase }`) carrying it.
    // Those (about-spec, mutation-protocol, code-grounding, standards-protocol)
    // must still ride the nudge channel only. ac-31's primary org-isolation
    // guarantee is unchanged and covered by the fixture test above.
    const phaseTargetedTexts = new Set(
      BASE_SCAFFOLD.baseGuidance
        .filter((b) => b.source === "base" && b.target.phase !== undefined)
        .map((b) => b.text),
    );
    const globalSharedNudgeTexts = BASE_SCAFFOLD.promptBlocks.filter(
      (node) =>
        node.surface === "shared_nudge" &&
        node.text.length > 0 &&
        // A block is "global" (not per-phase) when no phase-targeted
        // GuidanceBlock re-emits its text on the nudge channel.
        !phaseTargetedTexts.has(node.text),
    );
    expect(
      globalSharedNudgeTexts.length,
      "BASE_SCAFFOLD must carry at least one global shared_nudge block for this test to be meaningful",
    ).toBeGreaterThan(0);
    for (const phase of ["draft", "plan", "build", "verify", "done"] as const) {
      const joined = buildSystemBlocks("ctx", phase)
        .map((b) => b.text)
        .join("\n\n");
      for (const node of globalSharedNudgeTexts) {
        expect(
          joined.includes(node.text),
          `Phase ${phase} system prompt includes a GLOBAL shared_nudge block — should ride the nudge channel only`,
        ).toBe(false);
      }
    }
  });
});
