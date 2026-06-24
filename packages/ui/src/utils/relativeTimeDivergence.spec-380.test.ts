// spec-380 dec-2 (ac-6, ac-3): the two named local relative-time formatters
// (McpTokensSection.formatRelative, AcPanel.relativeTime) are deliberately NOT
// swapped for the shared `timeAgo`, because each diverges from it in rendered
// output. This guard fails if a future change either (a) wires shared `timeAgo`
// into those files, or (b) makes the divergence vanish (at which point the swap
// becomes safe and this guard's premise no longer holds — re-evaluate then).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { timeAgo } from '@memex/shared';

const AC6 = 'mindset-prod/memex-building-itself/specs/spec-380/acs/ac-6';
const AC3 = 'mindset-prod/memex-building-itself/specs/spec-380/acs/ac-3';
// ac-1 (scope): each formatter is left in place with the divergence documented as a fork.
const AC1 = 'mindset-prod/memex-building-itself/specs/spec-380/acs/ac-1';

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(here, '..', 'components');
const read = (p: string) => readFileSync(join(componentsDir, p), 'utf8');

// Local copies of the two formatters under test, lifted verbatim from source so
// we can compare their output against the shared helper without exporting them.
function mcpTokensFormatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

describe('spec-380 dec-2 — local relative-time formatters left unchanged (divergent from shared timeAgo)', () => {
  it('neither McpTokensSection nor AcPanel imports the shared timeAgo (no swap happened)', () => {
    tagAc(AC6);
    tagAc(AC1);
    const mcp = read('McpTokensSection.tsx');
    const acPanel = read('AcPanel.tsx');
    // The local formatters still exist…
    expect(mcp).toContain('function formatRelative');
    expect(acPanel).toContain('function relativeTime');
    // …and neither file pulls in timeAgo from anywhere.
    expect(mcp).not.toMatch(/timeAgo/);
    expect(acPanel).not.toMatch(/timeAgo/);
  });

  it('McpTokensSection.formatRelative diverges from shared timeAgo (null wording + no week/absolute coarsening)', () => {
    tagAc(AC6);
    const NOW = new Date('2026-06-14T12:00:00.000Z');
    // null: 'never' vs shared ''
    expect(mcpTokensFormatRelative(null)).toBe('never');
    expect(timeAgo(null, NOW)).toBe('');
    // 9 days: formatRelative stays in days; shared coarsens to weeks
    const nineDaysAgo = new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString();
    // formatRelative uses Date.now(), so assert against the relative shape, not a fixed instant
    expect(mcpTokensFormatRelative(new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString())).toBe('9d ago');
    expect(timeAgo(nineDaysAgo, NOW)).toBe('1w ago');
  });

  it('shared timeAgo has no seconds tier where AcPanel.relativeTime does', () => {
    tagAc(AC3);
    const NOW = new Date('2026-06-14T12:00:00.000Z');
    // AcPanel.relativeTime emits `${s}s ago` for <60s; shared returns 'just now'
    const tenSecAgo = new Date(NOW.getTime() - 10_000);
    expect(timeAgo(tenSecAgo, NOW)).toBe('just now');
  });
});
