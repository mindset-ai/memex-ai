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

// A summary line is a single sentence sized for a terse reference block. The
// longest real entry is ~140 chars; 240 leaves headroom without letting a
// paragraph slip in.
const MAX_SUMMARY_LEN = 240;

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
