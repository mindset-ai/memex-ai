// spec-503: the manifest is the steering surface (std-16) — edit_section must
// exist as a planning verb and update_section must point targeted edits at it,
// with both summaries inside the manifest bound.
import { describe, expect, it } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { toolManifest } from './tool-manifest.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-503/acs/ac-${n}`;

// Mirrors MAX_SUMMARY_LEN in tool-manifest.test.ts — kept in both places so a
// bound change is a deliberate two-file edit.
const MAX_SUMMARY_LEN = 240;

describe('spec-503: edit_section manifest entry + update_section steering', () => {
  const editEntry = toolManifest.find((e) => e.name === 'edit_section');
  const updateEntry = toolManifest.find((e) => e.name === 'update_section');

  it('edit_section is a planning-group mutating verb with the one-pair args shape', () => {
    tagAc(AC(9));
    expect(editEntry).toBeDefined();
    expect(editEntry!.group).toBe('planning');
    expect(editEntry!.readOnlyHint).toBe(false);
    expect(editEntry!.args).toBe('edit_section(ref, oldText, newText, replaceAll?)');
  });

  it('edit_section summary leads with the cost advantage and names the failure remedies', () => {
    tagAc(AC(9));
    tagAc(AC(6));
    const summary = editEntry!.summary;
    expect(summary).toMatch(/no body re-emission/i);
    expect(summary).toMatch(/replaceAll/);
    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
  });

  it('update_section is marked as full-body replacement and steers to edit_section', () => {
    tagAc(AC(9));
    tagAc(AC(6));
    const summary = updateEntry!.summary;
    expect(summary).toMatch(/ENTIRE markdown body/);
    expect(summary).toMatch(/prefer edit_section/);
    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
  });
});
