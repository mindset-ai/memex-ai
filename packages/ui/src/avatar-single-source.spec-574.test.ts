import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-574 — a person has ONE avatar. Six surfaces once each derived initials their own
// way, so the same person read differently across the app. `avatarText` in @memex/shared
// is now the only derivation, and components/ui/Avatar.tsx the only renderer. This guard
// fails if a component starts deriving initials from a name or email again.
//
// What it cannot see: a derivation written in a shape none of the patterns below match.
// The patterns are the shapes every one of the six copies actually took, so reintroducing
// any of them is caught; the Avatar tests pin the rule itself.
const AC_ONE_COMPONENT = 'mindset-prod/memex-building-itself/specs/spec-574/acs/ac-11';

const SRC = join(__dirname);

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'a local initials helper', pattern: /function\s+initials(Of)?\s*\(/ },
  { name: 'a first letter of a name/label/email', pattern: /\b(name|label|email|actorName|authorName)\??\.(charAt\(0\)|\[0\])/ },
  { name: 'first two letters upper-cased', pattern: /\.slice\(0,\s*2\)\.toUpperCase\(\)/ },
  { name: 'first + last initial', pattern: /parts\[parts\.length\s*-\s*1\]!?\[0\]/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'test') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('spec-574: one avatar derivation', () => {
  const files = sourceFiles(SRC);

  it('scans the UI source tree (vacuity guard)', () => {
    tagAc(AC_ONE_COMPONENT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('components', 'ui', 'Avatar.tsx')))).toBe(true);
  });

  it('no component derives initials outside the shared avatar rule', () => {
    tagAc(AC_ONE_COMPONENT);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${relative(SRC, file)}: ${name}`);
      }
    }
    expect(
      offenders,
      'Render the person with <Avatar person={...} /> from components/ui/Avatar; the letters come from avatarText in @memex/shared.',
    ).toEqual([]);
  });

  it('the patterns catch every shape the old copies took', () => {
    tagAc(AC_ONE_COMPONENT);
    const oldShapes = [
      'function initials(label: string): string {',
      'function initialsOf(name: string): string {',
      '{user.name.charAt(0).toUpperCase()}',
      "{w.actorName?.[0]?.toUpperCase() ?? 'U'}",
      'return parts[0]!.slice(0, 2).toUpperCase();',
      'return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();',
    ];
    for (const shape of oldShapes) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(shape)), shape).toBe(true);
    }
  });
});
