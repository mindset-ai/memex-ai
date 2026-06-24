// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
} from "../../mcp/refs.js";
import {
  listDecisions,
} from "../../services/decisions.js";
import {
  createAc,
  listAcsForBrief,
  listAcsForBriefWithVerification,
  listResolvedDecisionImplAcCoverage,
  updateAc,
  deleteAc,
  linkAcToParent,
  listTestEventDigestForAc,
  discontinueTestEventsForAc,
  type AcKind,
  type AcStatus,
  type AcWithVerification,
} from "../../services/acs.js";
import {
  fetchTopic,
} from "../../services/guidance.js";
import {
  mintEphemeralEmissionKey,
} from "../../services/emission-keys.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  VERBOSE_FIELD,
  formatAcCoverageSummary,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  verificationStateForAc,
  type ToolSpec,
} from "./shared.js";

export const acsTools: ToolSpec[] = [
  {
    name: "create_ac",
    annotations: { title: "Create acceptance criterion", readOnlyHint: false, destructiveHint: false },
    description:
      "Create an acceptance criterion (AC) under a Spec. Two flavours: " +
      "`kind: 'scope'` for manager-authored plain-English outcome commitments " +
      "(typically authored with the Spec and rendered with the Spec body), and " +
      "`kind: 'implementation'` for technical assertions spawned from a resolved " +
      "Decision (typically auto-accepted; pass `parent_decision_ref` to link). " +
      "ACs are addressable as `ac-N` and have zero or more tests in the codebase " +
      "that emit pass/fail events to POST /api/test-events tagged with the AC handle. " +
      "Before you write the verifying test for an implementation-kind AC you create here, " +
      "MUST call `get_information(topic='ac-emission')` if you haven't already — the " +
      "test-tagging mechanism is silent and undetectable if skipped.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the parent Spec, e.g. `mindset/main/specs/b-3`.",
      ),
      kind: z.enum(["scope", "implementation"]).describe(
        "AC flavour: 'scope' for manager-authored outcome commitments, " +
        "'implementation' for agent-spawned technical assertions.",
      ),
      statement: z.string().describe(
        "The forward-facing statement of what the system must do. Plain English " +
        "for scope; technical/mechanism-shaped for implementation.",
      ),
      status: z.enum(["proposed", "active"]).optional().describe(
        "Initial status. Default 'active' (the auto-accept path). Use 'proposed' " +
        "for ACs that need explicit human review before they take effect.",
      ),
      parent_decision_ref: z.string().optional().describe(
        "Optional canonical ref to a parent Decision (for Implementation ACs), " +
        "e.g. `mindset/main/specs/b-3/decisions/dec-7`. If omitted, no Decision " +
        "parent is recorded; for Scope ACs, the AC's parent is the Spec itself.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind;
      const statement = input.statement as string;
      const status = (input.status as AcStatus | undefined) ?? "active";
      const parentDecisionRef = input.parent_decision_ref as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_ac expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Resolve optional parent Decision ref to its UUID.
      // The parent-kind discriminator is the DB `ac_parent_links.parent_kind`
      // value (CHECK IN ('brief','decision')); it stays "brief" — see
      // services/acs.ts ParentKind. Not the product noun.
      let parent: { kind: "brief" | "decision"; id: string } | undefined;
      if (parentDecisionRef) {
        const parentResolved = await resolveRefArg(ctx, parentDecisionRef, "parent_decision_ref");
        if (parentResolved.entity.kind !== "decision") {
          throw new ValidationError(
            `parent_decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
          );
        }
        parent = { kind: "decision", id: parentResolved.entity.row.id };
      } else if (kind === "scope") {
        // Scope AC default parent: the Spec itself, so blast-radius cascades work.
        parent = { kind: "brief", id: doc.id };
      }

      const ac = await createAc({
        memexId,
        briefId: doc.id,
        kind,
        statement,
        status,
        parent,
      }, reqCtx(ctx));

      // spec-219 comb-through: count-aware AC call-to-action. The handler parks
      // DATA only; renderFooterSignal owns every word. For implementation ACs it
      // also parks the build-gate picture (resolved-decision coverage + open
      // decisions) so the footer can push toward build the moment it's earned —
      // the only phone-home Memex has for "stop lingering in specify while code is
      // being written". Sourced from the rubric's own coverage helper so the
      // footer and assess_spec speak with one voice. Net-new guidance.
      if (ctx.footerSlot) {
        const sameKind = await listAcsForBrief(memexId, doc.id, { kind, status: "active" });
        let coverage:
          | { phase: string; resolvedCount: number; uncovered: string[]; open: string[] }
          | undefined;
        if (kind === "implementation") {
          const [allDecs, cov] = await Promise.all([
            listDecisions(memexId, doc.id),
            listResolvedDecisionImplAcCoverage(memexId, doc.id),
          ]);
          coverage = {
            phase: doc.status,
            resolvedCount: cov.length,
            uncovered: cov
              .filter((c) => c.implementationAcCount === 0)
              .map((c) => c.decisionHandle),
            open: allDecs.filter((d) => d.status === "open").map((d) => `dec-${d.seq}`),
          };
        }
        ctx.footerSlot.signal = {
          kind: "ac_created",
          acKind: kind,
          sameKindCount: sameKind.length,
          coverage,
        };
      }

      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Created AC ${acRef} (${kind}, status=${status}): "${statement}"` +
          (parent ? ` linked to ${parent.kind}` : "");
      }
      return `ref: ${acRef} [${kind}, ${status}]`;
    },
  },
  {
    // spec-234: the agent-facing onboarding for AC emission. One call mints an
    // ephemeral, spec-scoped key AND returns the integration guidance — replacing the
    // "open Settings, mint a key, copy it, npm install a helper" detour. The key is
    // short-lived (so it's safe to return through the MCP transcript, dec-1/dec-5) and
    // scoped to this Spec. The guidance half is rendered from the SAME source as
    // get_information(topic='ac-emission-bootstrap'), never hand-copied (std-22, ac-16).
    name: "provision_ac_emission",
    annotations: { title: "Provision AC emission", readOnlyHint: false, destructiveHint: false },
    description:
      "Provision AC emission for the Spec you are working on, in one call: (1) mints a " +
      "working, ephemeral, spec-scoped emission key for this repo's Memex and returns the " +
      "raw value once, and (2) returns markdown guidance for wiring emission into whatever " +
      "test runner(s) the repo actually uses — authoring a native integration when no " +
      "official helper exists for the stack. No Settings-UI detour and no package install " +
      "are needed to start emitting. The key is short-lived (~2h) and may ONLY record " +
      "emissions for this Spec; use it in the test process environment for THIS session and " +
      "do not persist it — call again next session for a fresh key. For a long-lived CI key, " +
      "a human mints one in Settings → Emission Keys (this tool does not produce CI keys).",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec you are working on, e.g. `mindset/main/specs/spec-3`. " +
          "The provisioned key is scoped to this Spec.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind) || resolved.doc.docType !== "spec") {
        throw new ValidationError(
          `provision_ac_emission expects a Spec ref (e.g. .../specs/spec-N); got ${resolved.entity.kind}/${resolved.doc.docType}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const specHandle = doc.handle; // e.g. "spec-3" — matches the ac_uid's /specs/<handle>/ segment
      const specRef = `${slugs.namespace}/${slugs.memex}/specs/${specHandle}`;

      // Member-level authority (dec-5): resolveRef already asserted the caller is a member of
      // this Memex, so minting here is the same authority as the Settings-UI mint. The minting
      // user is recorded (created_by_user_id) for audit.
      const minted = await mintEphemeralEmissionKey(memexId, specHandle, ctx.userId);
      const expiresAt = minted.row.expiresAt!; // always set for an ephemeral key

      // Render the protocol from the shared guidance source — NOT a hand-copied duplicate
      // (ac-16). This is the same body get_information(topic='ac-emission-bootstrap') serves.
      const bootstrap = await fetchTopic("ac-emission-bootstrap");

      return [
        `# AC emission provisioned for \`${specRef}\``,
        "",
        "## 1. Your emission key (use this session only — do NOT save it to disk)",
        "",
        "```",
        `MEMEX_EMIT_KEY=${minted.raw}`,
        "```",
        "",
        `- **Ephemeral:** this key expires at ${expiresAt.toISOString()} (~2h). It is **scoped to \`${specHandle}\`** — it can only record emissions for this Spec, nothing else on the board.`,
        "- **Do not persist it.** Export it into the environment of the test process for THIS session only " +
          "(e.g. `MEMEX_EMIT_KEY=… <run your tests>`). Do not write it to `.env`, CI config, or any file — " +
          "it will be expired by next session. When you start a fresh session, call `provision_ac_emission` " +
          "again for a new key.",
        "- **CI is different:** a long-lived key for a CI pipeline is minted by a human in Settings → Emission " +
          "Keys and stored as a CI secret. This tool only provisions the short-lived agent key.",
        "",
        "## 2. Wire emission into the repo's test runner(s)",
        "",
        "Detect the test runner(s) **this** repo actually uses (do not assume one). For each suite: if an " +
          "official Memex helper exists for that stack, prefer it; otherwise hand-roll the native emitter using " +
          "the protocol below. A repo with multiple suites (e.g. a web suite plus a mobile/native suite) wires " +
          "emission into **every** suite, not just one. Tag each test with the AC ref it verifies and the emitter " +
          "POSTs the result — no package install is required to begin.",
        "",
        "---",
        "",
        bootstrap.body,
      ].join("\n");
    },
  },
  {
    name: "list_acs",
    annotations: { title: "List acceptance criteria", readOnlyHint: true, destructiveHint: false },
    description:
      "List acceptance criteria on a Spec, optionally filtered by `kind` " +
      "('scope' | 'implementation') or `status` ('proposed' | 'active' | 'rejected' | 'superseded'). " +
      "Each row carries its current verification state derived from `test_events`: " +
      "`verified` (all tagged tests pass) / `failing` (any latest emission is fail) / `stale` " +
      "(all pass but oldest is >7 days) / `untested` (no tagged tests yet). " +
      "**The header line shows coverage % (ACs with ≥1 tagged test) and verification %** so a quick glance " +
      "tells you where the gaps are. An AC sitting at 0 tests in build phase is silent debt — write a tagged " +
      "test before declaring any task done.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec, e.g. `mindset/main/specs/b-3`.",
      ),
      kind: z.enum(["scope", "implementation"]).optional().describe("Filter by AC flavour."),
      status: z.enum(["proposed", "active", "rejected", "superseded"]).optional().describe("Filter by status."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind | undefined;
      const status = input.status as AcStatus | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `list_acs expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Use the verification-enriched service so every row carries its
      // test count + derived state. Filtering is client-side because the
      // service signature doesn't accept filters — the row set is tiny
      // (rarely > 50 ACs per Spec) so the JS pass is negligible.
      const allRows: AcWithVerification[] =
        await listAcsForBriefWithVerification(memexId, doc.id);
      let rows = allRows;
      if (kind) rows = rows.filter((r) => r.ac.kind === kind);
      if (status) rows = rows.filter((r) => r.ac.status === status);

      if (rows.length === 0) {
        return `No ACs on ${slugs.namespace}/${slugs.memex}/specs/${doc.handle} matching the filter.`;
      }

      // spec-207 ac-3 — a kind/status filter shrinks `rows`; surface how many
      // active ACs it hides so a filtered view can't silently understate the
      // gap. Counted over the active set on both sides (proposed/superseded ACs
      // aren't part of the "is this done?" signal).
      const filterActive = Boolean(kind || status);
      const hiddenByFilter = filterActive
        ? allRows.filter((r) => r.ac.status === "active").length -
          rows.filter((r) => r.ac.status === "active").length
        : 0;

      // Aggregate header — the coverage gap is the action signal. The agent
      // enumerates ACs constantly during build; spec-207 dec-1 routes the
      // headline through the shared `formatAcCoverageSummary` so it leads with
      // the not-verified gap (and the filter-hiding warning) instead of a
      // self-flattering "verified (of covered)" trophy.
      const covered = rows.filter((r) => r.tests.length > 0).length;
      const untested = rows.length - covered;
      const verified = rows.filter((r) => r.verificationState === "verified").length;
      const failing = rows.filter((r) => r.verificationState === "failing").length;
      const stale = rows.filter((r) => r.verificationState === "stale").length;

      const summary = formatAcCoverageSummary(rows, { hiddenByFilter });
      // Full state distribution stays below the headline as a breakdown.
      const breakdown: string[] = [];
      if (verified > 0) breakdown.push(`${verified} verified`);
      if (failing > 0) breakdown.push(`${failing} failing`);
      if (stale > 0) breakdown.push(`${stale} stale`);
      if (untested > 0) breakdown.push(`${untested} UNTESTED`);

      // Decision-coverage line — mirrors the test-coverage signal one level
      // up: "how many resolved decisions have at least one implementation
      // AC?" A resolved decision without an implementation AC is a
      // commitment without a verification path; see guidance topic
      // `decisions-need-acs`. Best-effort — fails silently if the helper
      // throws so list_acs stays usable even if the join breaks.
      let decisionLine = "";
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        if (decCoverage.length > 0) {
          const withAc = decCoverage.filter(
            (c) => c.implementationAcCount > 0,
          ).length;
          const nakedHandles = decCoverage
            .filter((c) => c.implementationAcCount === 0)
            .map((c) => c.decisionHandle);
          const naked = nakedHandles.length;
          decisionLine = `\n${decCoverage.length} resolved decision${decCoverage.length === 1 ? "" : "s"} · ${withAc}/${decCoverage.length} with implementation ACs`;
          if (naked > 0) {
            decisionLine += ` (NAKED: ${nakedHandles.join(", ")})`;
          }
        }
      } catch {
        // Best-effort.
      }

      const header = `${summary}\nBreakdown: ${breakdown.join(", ")}${decisionLine}`;

      // Per-row line — surfaces the AC's tagged-test count so the gap is
      // visible per AC, not just in the aggregate. UNTESTED is uppercase
      // so it pops in the agent's context.
      const lines = rows.map((r) => {
        const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
        const testStatus =
          r.tests.length === 0
            ? "0 tests · UNTESTED"
            : `${r.tests.length} test${r.tests.length === 1 ? "" : "s"} · ${r.verificationState}`;
        return `- ref: ${acRef} [${r.ac.kind}, ${r.ac.status}] (${testStatus}) "${r.ac.statement}"`;
      });

      // Tail nudges: surface the two action signals when present —
      //   1. tests-missing: untested ACs need tagged tests
      //   2. ACs-missing-from-decisions: resolved decisions without
      //      implementation ACs are commitments without a verification path
      // Both cite their respective guidance topic so the agent can ground
      // the rule before acting.
      const tailParts: string[] = [];
      if (untested > 0) {
        tailParts.push(
          `${untested} AC${untested === 1 ? " is" : "s are"} untested. ` +
            `If you're in build / verify, write tagged tests for these before declaring any task done. ` +
            `See get_information(topic='test-coverage') for the discipline.`,
        );
      }
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        const naked = decCoverage.filter((c) => c.implementationAcCount === 0);
        if (naked.length > 0) {
          const handles = naked.map((c) => c.decisionHandle).join(", ");
          tailParts.push(
            `${naked.length} resolved decision${naked.length === 1 ? "" : "s"} (${handles}) ${naked.length === 1 ? "has" : "have"} no implementation AC. ` +
              `Author at least one via \`create_ac({kind:'implementation', parent_decision_ref:'<dec-ref>', ...})\` before specify→build. ` +
              `See \`get_information(topic='decisions-need-acs')\` for the discipline.`,
          );
        }
      } catch {
        // Best-effort.
      }

      // spec-127 ac-6: orphan awareness. For every FAILING AC, name the
      // test_identifier(s) pinning it red and point to the ref-keyed retire
      // path — so an agent that just renamed/deleted a tagged test discovers
      // and clears its own orphan in-flow. We do NOT claim these ARE orphans
      // (the server can't tell "renamed away" from "failed for real"); we
      // surface the candidates + the affordance and leave the judgement to the
      // actor who knows the codebase (dec-1).
      const failingRows = rows.filter((r) => r.verificationState === "failing");
      if (failingRows.length > 0) {
        const pinLines = failingRows.map((r) => {
          const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
          const ids = r.tests
            .filter((t) => t.latestStatus === "fail" || t.latestStatus === "error")
            .map((t) => `"${t.testIdentifier ?? "(no identifier)"}"`);
          return `- ${acRef} pinned by ${ids.join(", ")}`;
        });
        tailParts.push(
          `${failingRows.length} failing AC${failingRows.length === 1 ? "" : "s"} — if a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref, test_identifier)\` (inspect first with \`get_test_matrix(ref)\`). ` +
            `See \`get_information(topic='orphaned-test-events')\`.\n${pinLines.join("\n")}`,
        );
      }
      const tail = tailParts.length > 0 ? `\n\n${tailParts.join("\n\n")}` : "";

      return `${header}\n\n${lines.join("\n")}${tail}`;
    },
  },
  {
    name: "get_ac",
    annotations: { title: "Get acceptance criterion", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a single AC by canonical ref. Returns the kind, status, statement, " +
      "and (in verbose mode) the full record.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = entity.row;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });

      // spec-127 ac-6: when this AC is held red, name the pinning identifier(s)
      // and point to the ref-keyed retire path, so an agent inspecting an AC it
      // just broke by renaming a test discovers and clears its own orphan. The
      // digest read is best-effort — a miss never fails get_ac.
      let orphanHint = "";
      try {
        const digest = await listTestEventDigestForAc(memexId, ac.id);
        const pinning = digest.filter((d) => d.pinning);
        if (pinning.length > 0) {
          const ids = pinning
            .map((d) => `"${d.testIdentifier === "" ? "(no identifier)" : d.testIdentifier}"`)
            .join(", ");
          orphanHint =
            `\n⚠ This AC reads failing — pinned by ${ids}. If a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref="${acRef}", test_identifier=…)\` ` +
            `(inspect with \`get_test_matrix(ref="${acRef}")\`). See \`get_information(topic='orphaned-test-events')\`.`;
        }
      } catch {
        // Best-effort.
      }

      if (ctx.verbose) {
        return `ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"${orphanHint}`;
      }
      return `ref: ${acRef} [${ac.kind}, ${ac.status}] "${ac.statement}"${orphanHint}`;
    },
  },
  {
    name: "get_test_matrix",
    annotations: {
      title: "Read an AC's test-event matrix",
      readOnlyHint: true,
      destructiveHint: false,
    },
    description:
      "Read the per-`test_identifier` test-event digest for one AC, keyed by its " +
      "canonical ref. One row per identifier: latest (non-hidden) status, last run " +
      "time, emission count, and two flags — `PINNING red` (this identifier's latest " +
      "emission is fail/error, so it holds the AC red) and `retired (hidden)` (a legacy " +
      "hidden row, invisible to the verdict — kept for audit; spec-358 froze the column). " +
      "Use this when an AC reads `failing`/`stale` " +
      "to find WHICH identifier is responsible — then, if you renamed/deleted that test " +
      "in the codebase, retire its orphan with `discontinue_test_events`. See " +
      "`get_information(topic='orphaned-test-events')`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_test_matrix expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const rows = await listTestEventDigestForAc(memexId, entity.row.id);
      if (rows.length === 0) {
        return `ref: ${acRef}\nNo test events recorded for this AC yet.`;
      }
      const lines = rows.map((r) => {
        const id = r.testIdentifier === "" ? "(no identifier)" : r.testIdentifier;
        const status = r.hidden ? "retired" : (r.latestStatus ?? "—");
        const last = r.latestRunAt ? r.latestRunAt.toISOString() : "—";
        const flags: string[] = [];
        if (r.pinning) flags.push("PINNING red");
        if (r.hidden) flags.push("retired (hidden)");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        return `- ${id} — latest ${status}, ${r.count} emission${r.count === 1 ? "" : "s"}, last ${last}${flagStr}`;
      });
      return `ref: ${acRef}\n${lines.join("\n")}`;
    },
  },
  {
    name: "discontinue_test_events",
    annotations: {
      title: "Discontinue (hard-delete) an orphaned test_identifier",
      readOnlyHint: false,
      destructiveHint: true,
    },
    description:
      "Retire an orphaned `test_identifier` on an AC — a test you renamed/moved/deleted " +
      "in the codebase whose last emission still pins the AC red. HARD DELETE, irreversible " +
      "(spec-358): it removes the matching emissions and clears their verification summary, " +
      "the same thing the UI 'Delete test events' button does. There is no undo — but a " +
      "fresh live emission of the same identifier re-enters the verdict on its own. Only " +
      "retire an identifier you KNOW no longer exists in the codebase — not one that merely " +
      "wasn't run this round. Find the identifier with `get_test_matrix`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-3/acs/ac-2`.",
      ),
      test_identifier: z.string().describe(
        "The exact test_identifier to retire (as shown by get_test_matrix), " +
          "e.g. `tests/cache.test.ts::uses redis`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // Resolve the ref FIRST so the std-10 UUID boundary guard fires before
      // any other validation (b-36 D-7 — the canonical error must win).
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `discontinue_test_events expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const testIdentifier = input.test_identifier as string;
      if (!testIdentifier?.trim()) {
        throw new ValidationError("test_identifier is required.");
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const result = await discontinueTestEventsForAc(
        memexId,
        entity.row.id,
        testIdentifier,
      );
      const state = await verificationStateForAc(memexId, doc.id, entity.row.id);
      if (result.deleted === 0) {
        return `ref: ${acRef} — no emissions matched "${testIdentifier}"; nothing retired. AC verification: ${state}.`;
      }
      return `ref: ${acRef} — retired (hard-deleted) ${result.deleted} emission${result.deleted === 1 ? "" : "s"} of "${testIdentifier}". AC verification is now: ${state}. This is irreversible; a fresh live emission re-enters the verdict.`;
    },
  },
  {
    name: "link_ac_to_decision",
    annotations: { title: "Link AC to a parent Decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a parent-Decision link to an existing AC. Used when an AC needs to be " +
      "associated with a Decision that wasn't its origin (e.g. cross-cutting " +
      "Implementation ACs spawned from multiple Decisions). For typical " +
      "Decision-spawned ACs, pass the parent_decision_ref argument to create_ac instead.",
    schema: {
      ac_ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      decision_ref: z.string().describe(
        "Canonical ref to the parent Decision, e.g. `mindset/main/specs/b-3/decisions/dec-7`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const acRefArg = input.ac_ref as string;
      const decisionRef = input.decision_ref as string;

      const acResolved = await resolveRefArg(ctx, acRefArg, "ac_ref");
      if (acResolved.entity.kind !== "ac") {
        throw new ValidationError(
          `ac_ref expects an ac ref; got ${acResolved.entity.kind}.`,
        );
      }
      const parentResolved = await resolveRefArg(ctx, decisionRef, "decision_ref");
      if (parentResolved.entity.kind !== "decision") {
        throw new ValidationError(
          `decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
        );
      }
      await linkAcToParent(acResolved.memexId, acResolved.entity.row.id, {
        kind: "decision",
        id: parentResolved.entity.row.id,
      });
      const acRefOut = buildChildRef(acResolved.slugs, acResolved.doc, {
        type: "acs",
        seq: acResolved.entity.row.seq,
      });
      const decRefOut = buildChildRef(parentResolved.slugs, parentResolved.doc, {
        type: "decisions",
        seq: parentResolved.entity.row.seq,
      });
      return `Linked ref: ${acRefOut} to ref: ${decRefOut}`;
    },
  },
  {
    name: "update_ac",
    annotations: { title: "Update AC statement", readOnlyHint: false, destructiveHint: false },
    description:
      "Update the statement text of an existing AC. Only the statement is " +
      "mutable here; kind is fixed at creation, and status transitions go " +
      "through accept_ac / reject_ac (when exposed). Use this to polish " +
      "wording, sharpen falsifiability, or fix typos.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      statement: z.string().describe("New statement text. Must be non-empty."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const statement = input.statement as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `update_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await updateAc(memexId, entity.row.id, statement, reqCtx(ctx));
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Updated ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"`;
      }
      return `Updated ref: ${acRef} [${ac.kind}, ${ac.status}]`;
    },
  },
  {
    name: "delete_ac",
    annotations: { title: "Delete AC", readOnlyHint: false, destructiveHint: true },
    description:
      "Hard-delete an AC. FK cascades remove its parent links and any " +
      "task_satisfies_ac rows pointing at it. Prefer reject_ac (status " +
      "transition, preserves history) over delete for ACs that were " +
      "considered and dismissed; delete is for accidents or duplicates.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/b-3/acs/ac-2`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `delete_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await deleteAc(memexId, entity.row.id);
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Deleted ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}) "${ac.statement}"`;
      }
      return `Deleted ref: ${acRef}`;
    },
  },

  // ── Task CRUD ────────────────────────────────────────────
];
