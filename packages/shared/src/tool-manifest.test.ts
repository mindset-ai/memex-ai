// b-67: data-integrity guards for the single-source coding-agent tool manifest.
//
// `tool-manifest.ts` is the canonical, plain-data description of the MCP tool
// surface — consumed by the React UI Init Prompt and cross-checked against the
// live server catalogue (see packages/server/src/__regression__/
// tools-coverage.regression.test.ts and the arg-parity test next to it). These
// tests pin the SHAPE of each entry so a hand-edit can't introduce a malformed
// row (empty field, bad group, duplicate name, signature that doesn't start
// with the tool name, multi-line summary). House style: dependency-free — the
// shared package carries no zod, so these assertions are plain data only.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { toolManifest, type ToolManifestEntry } from './tool-manifest.js';

const GROUPS: ReadonlyArray<ToolManifestEntry['group']> = [
  'read',
  'planning',
  'build',
  'comments',
];

// A summary line is a single sentence sized for a terse reference block — it is
// rendered into the Init Prompt's tool reference via scaffold-data.ts, NOT into
// the model-facing description the server composes in agent/handlers/*.
//
// 240 is the bound. Its old justification — "the longest real entry is ~140
// chars" — was false when spec-570 measured it: across all 75 entries the median
// was 163, p75 220, p90 234, and 42 entries already exceeded 140. A number whose
// stated reason has quietly become untrue is a number nobody is really checking,
// which is how four entries at 306-454 shipped past it.
//
// So the reason is asserted now instead of written down. MIN_HEADROOM is the
// gap the bound must keep over the longest shipped summary; at 20 it means no
// entry may exceed 220, which sits just above the compliant population's p90
// (214 after spec-570's shortening) and well clear of the median.
//
// WHEN THIS GOES RED, SHORTEN THE ENTRY. Do not raise MIN_HEADROOM and do not
// raise MAX_SUMMARY_LEN: lifting the number to fit the text is precisely the
// move that turned "~140" into a comment sitting beside a population of 234.
// The population is dense in the 211-220 band, so the margin is deliberately
// tight — a new summary that needs 221 characters needs one fewer clause.
const MAX_SUMMARY_LEN = 240;
const MIN_HEADROOM = 20;

describe('toolManifest data integrity (b-67)', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(toolManifest)).toBe(true);
    expect(toolManifest.length).toBeGreaterThan(0);
  });

  describe('every entry is well-formed', () => {
    for (const entry of toolManifest) {
      describe(`entry ${entry.name || '(unnamed)'}`, () => {
        it('has a non-empty name', () => {
          expect(typeof entry.name).toBe('string');
          expect(entry.name.trim().length).toBeGreaterThan(0);
        });

        it('has a non-empty summary', () => {
          expect(typeof entry.summary).toBe('string');
          expect(entry.summary.trim().length).toBeGreaterThan(0);
        });

        it('has a non-empty args signature', () => {
          expect(typeof entry.args).toBe('string');
          expect(entry.args.trim().length).toBeGreaterThan(0);
        });

        it('has a valid group', () => {
          expect(GROUPS).toContain(entry.group);
        });

        // spec-156 ac-25: the manifest is the single source of the
        // read-vs-mutating split. Every entry must declare readOnlyHint so the
        // mutate-coverage endpoint gate can derive the mutating set from it.
        it('declares a boolean readOnlyHint', () => {
          expect(typeof entry.readOnlyHint).toBe('boolean');
        });

        it("args is a signature starting with the tool name: /^<name>\\(.*\\)$/", () => {
          // Escape regex-special chars in the name (none today, but the
          // double-underscore memex__send_slack_message stays literal).
          const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${escaped}\\(.*\\)$`);
          expect(
            re.test(entry.args),
            `args "${entry.args}" must match /^${entry.name}\\(.*\\)$/`,
          ).toBe(true);
        });

        it('summary is a single line within the length bound', () => {
          expect(entry.summary).not.toMatch(/[\r\n]/);
          expect(entry.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
        });
      });
    }
  });

  it('names are unique (no duplicates)', () => {
    const names = toolManifest.map((e) => e.name);
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of names) {
      if (seen.has(n)) dupes.push(n);
      seen.add(n);
    }
    expect(dupes, dupes.length ? `duplicate names: ${dupes.join(', ')}` : '').toEqual([]);
    expect(seen.size).toBe(names.length);
  });

  it('at least one entry exists per group', () => {
    for (const group of GROUPS) {
      const count = toolManifest.filter((e) => e.group === group).length;
      expect(count, `group "${group}" has no entries`).toBeGreaterThan(0);
    }
  });
});

// spec-176 ac-8 + ac-9 (dec-1, dec-2): no create_spec alias introduced;
// tool-manifest.ts is unchanged by this spec.
describe('spec-176: no create_spec alias in tool manifest (ac-8, ac-9)', () => {
  const AC176 = (n: number) =>
    `mindset-prod/memex-building-itself/specs/spec-176/acs/ac-${n}`;

  it('ac-8 + ac-9: toolManifest has no create_spec entry', () => {
    tagAc(AC176(8));
    tagAc(AC176(9));
    const entry = toolManifest.find((e) => e.name === 'create_spec');
    expect(entry).toBeUndefined();
  });
});

// spec-570 ac-5 + ac-7 (dec-1): the b-67 length bound had never passed in the
// repository's history — the constant and two of its violations shipped in the
// initial commit, and nothing automatic ran this suite to say so. These two
// assertions are what the Spec's ACs are verified by; the per-entry
// `summary is a single line within the length bound` test above stays the
// enforcing check for every future entry.
describe('spec-570: the bound keeps a measured margin (ac-6)', () => {
  const AC6 =
    'mindset-prod/memex-building-itself/specs/spec-570/acs/ac-6';

  it('ac-6: MAX_SUMMARY_LEN stays at least MIN_HEADROOM above the longest entry', () => {
    tagAc(AC6);
    const lengths = toolManifest.map((e) => e.summary.length);
    const longest = Math.max(...lengths);
    const entry = toolManifest.find((e) => e.summary.length === longest)!;
    expect(
      MAX_SUMMARY_LEN - longest,
      `the longest summary is "${entry.name}" at ${longest}, leaving ` +
        `${MAX_SUMMARY_LEN - longest} of headroom under ${MAX_SUMMARY_LEN}. ` +
        `Entries are crowding the bound — shorten "${entry.name}". Raising ` +
        `MIN_HEADROOM or MAX_SUMMARY_LEN to fit the text is how the previous ` +
        `justification ("the longest real entry is ~140 chars") came to sit ` +
        `beside a population whose p90 was 234.`,
    ).toBeGreaterThanOrEqual(MIN_HEADROOM);
  });

  it('ac-6: the margin is a real constraint, not a restatement of the bound', () => {
    tagAc(AC6);
    // A headroom of 0 would make this assertion equivalent to the per-entry
    // length check above — green by construction and incapable of reporting
    // crowding. Pinning the comment's cited maximum to Math.max(...) would be
    // worse still: `max === max` at rest, firing only on a legitimate edit.
    expect(MIN_HEADROOM).toBeGreaterThan(0);
    expect(MIN_HEADROOM).toBeLessThan(MAX_SUMMARY_LEN);
  });
});

describe('spec-570: the manifest length bound holds (ac-5, ac-7)', () => {
  const AC570 = (n: number) =>
    `mindset-prod/memex-building-itself/specs/spec-570/acs/ac-${n}`;

  it('ac-5: every summary is within MAX_SUMMARY_LEN, with no entry exempted', () => {
    tagAc(AC570(5));
    const over = toolManifest
      .filter((e) => e.summary.length > MAX_SUMMARY_LEN)
      .map((e) => `${e.name} (${e.summary.length})`);
    expect(
      over,
      over.length ? `entries over ${MAX_SUMMARY_LEN}: ${over.join(', ')}` : '',
    ).toEqual([]);
  });

  // dec-1 shortened five summaries. `summary` feeds scaffold-data.ts ->
  // BASE_SCAFFOLD.tools -> the Init Prompt reference block [per std-16 cl-20];
  // it is NOT the model-facing description, which the server composes in
  // agent/handlers/*. So the edit must move the summary and nothing else —
  // an args or group drift would break the std-16 lockstep in a way this
  // package's own suite would not otherwise catch.
  it('ac-7: the five shortened entries kept every non-summary field', () => {
    tagAc(AC570(7));
    const PINNED: ReadonlyArray<
      Pick<ToolManifestEntry, 'name' | 'args' | 'group' | 'readOnlyHint'>
    > = [
      {
        name: 'list_docs',
        args: 'list_docs(memex?, docType?, statusIn?, tags?)',
        group: 'read',
        readOnlyHint: true,
      },
      {
        name: 'supersede_spec',
        args: 'supersede_spec(ref, supersededBy, note?)',
        group: 'planning',
        readOnlyHint: false,
      },
      {
        name: 'propose_standard_change',
        args: 'propose_standard_change(operations, rationale?)',
        group: 'build',
        readOnlyHint: false,
      },
      {
        name: 'accept_standard_change',
        args: 'accept_standard_change(ref)',
        group: 'build',
        readOnlyHint: false,
      },
      {
        name: 'update_ac',
        args: 'update_ac(ref, statement)',
        group: 'build',
        readOnlyHint: false,
      },
    ];

    for (const pin of PINNED) {
      const entry = toolManifest.find((e) => e.name === pin.name);
      expect(entry, `manifest entry "${pin.name}" is missing`).toBeDefined();
      expect({
        name: entry!.name,
        args: entry!.args,
        group: entry!.group,
        readOnlyHint: entry!.readOnlyHint,
      }).toEqual(pin);
    }
  });
});
