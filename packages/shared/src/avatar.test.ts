import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  AVATAR_COLORS,
  AvatarColorError,
  AvatarLabelError,
  avatarColorStyle,
  avatarText,
  normalizeAvatarColor,
  normalizeAvatarLabel,
} from './avatar.js';

// spec-574: the one avatar rule. `normalizeAvatarLabel` is what both the profile form and
// the server accept; `avatarText` is what every avatar in the UI shows.
const SPEC = 'mindset-prod/memex-building-itself/specs/spec-574';
const AC_NORMALIZE = `${SPEC}/acs/ac-7`;
const AC_ONE_RULE = `${SPEC}/acs/ac-6`;

describe('normalizeAvatarLabel', () => {
  it('trims and upper-cases one or two letters', () => {
    tagAc(AC_NORMALIZE);
    expect(normalizeAvatarLabel('wv')).toBe('WV');
    expect(normalizeAvatarLabel('  Wv ')).toBe('WV');
    expect(normalizeAvatarLabel('q')).toBe('Q');
    // Non-ASCII letters are letters.
    expect(normalizeAvatarLabel('éø')).toBe('ÉØ');
  });

  it('maps absent or blank input to null, meaning "use the automatic rule"', () => {
    tagAc(AC_NORMALIZE);
    expect(normalizeAvatarLabel(null)).toBeNull();
    expect(normalizeAvatarLabel(undefined)).toBeNull();
    expect(normalizeAvatarLabel('')).toBeNull();
    expect(normalizeAvatarLabel('   ')).toBeNull();
  });

  it.each([
    ['three letters', 'abc'],
    ['a digit', 'W1'],
    ['a symbol', 'W!'],
    ['inner whitespace', 'W V'],
    ['an emoji', '🙂'],
    // Upper-casing ß yields "SS": the length rule applies to what is stored, not typed.
    ['letters that grow past two when upper-cased', 'ßß'],
    ['a non-string', 42],
  ])('rejects %s with a message naming the rule', (_label, raw) => {
    tagAc(AC_NORMALIZE);
    expect(() => normalizeAvatarLabel(raw)).toThrow(AvatarLabelError);
    expect(() => normalizeAvatarLabel(raw)).toThrow(/one or two letters/i);
  });
});

describe('avatarText', () => {
  it('prefers the nominated letters over anything derived from the name', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: 'Will Smith', email: 'w@x.io', avatarLabel: 'WV' })).toBe('WV');
  });

  it('derives first + last initial from a multi-part name', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: 'Barrie Hadfield' })).toBe('BH');
    expect(avatarText({ name: 'ada king lovelace' })).toBe('AL');
  });

  it('derives the first two letters of a one-word name', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: 'Sam' })).toBe('SA');
  });

  it('falls back to the email local part when there is no name', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: null, email: 'first.last@example.com' })).toBe('FL');
    expect(avatarText({ name: '  ', email: 'solo@example.com' })).toBe('SO');
  });

  it('returns "?" when there is nothing to derive from', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({})).toBe('?');
    expect(avatarText({ name: '', email: '' })).toBe('?');
  });

  it('treats a blank nominated label as absent', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: 'Sam', avatarLabel: '' })).toBe('SA');
    expect(avatarText({ name: 'Sam', avatarLabel: null })).toBe('SA');
  });
});

const AC_COLOR = `${SPEC}/acs/ac-14`;

// WCAG 2.x relative luminance / contrast ratio, to prove every palette fill keeps the
// white letters legible at avatar sizes (AA for normal text: 4.5:1).
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('avatar colours', () => {
  it('offers a palette of unique, lower-case keys with legible letters on every fill', () => {
    tagAc(AC_COLOR);
    expect(AVATAR_COLORS.length).toBeGreaterThanOrEqual(6);
    const keys = AVATAR_COLORS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of AVATAR_COLORS) {
      expect(c.key).toMatch(/^[a-z]{1,20}$/); // the users.avatar_color CHECK
      expect(contrast(c.background, c.text)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('normalizeAvatarColor accepts palette keys and maps blank/absent to null', () => {
    tagAc(AC_COLOR);
    expect(normalizeAvatarColor(AVATAR_COLORS[0]!.key)).toBe(AVATAR_COLORS[0]!.key);
    expect(normalizeAvatarColor(` ${AVATAR_COLORS[1]!.key.toUpperCase()} `)).toBe(AVATAR_COLORS[1]!.key);
    expect(normalizeAvatarColor(null)).toBeNull();
    expect(normalizeAvatarColor(undefined)).toBeNull();
    expect(normalizeAvatarColor('')).toBeNull();
  });

  it.each([['an unknown key', 'chartreuse'], ['a hex value', '#ff0000'], ['a non-string', 3]])(
    'normalizeAvatarColor refuses %s',
    (_label, raw) => {
      tagAc(AC_COLOR);
      expect(() => normalizeAvatarColor(raw)).toThrow(AvatarColorError);
    },
  );

  it('avatarColorStyle returns the pair for a palette key and null for anything else, never throwing', () => {
    tagAc(AC_COLOR);
    const blue = AVATAR_COLORS[0]!;
    expect(avatarColorStyle(blue.key)).toEqual({ backgroundColor: blue.background, color: blue.text });
    // A retired or corrupt key renders the neutral default rather than breaking a page.
    for (const bad of ['retired', '', null, undefined, 42, {}] as unknown[]) {
      expect(avatarColorStyle(bad)).toBeNull();
    }
  });
});

describe('avatar rule: review round 1', () => {
  it('uses letters only, never punctuation or symbols, for automatic initials', () => {
    tagAc(AC_ONE_RULE);
    expect(avatarText({ name: "O'Brien" })).toBe('OB');
    expect(avatarText({ name: '👍 Bob' })).toBe('BO');
    expect(avatarText({ name: 'Anne-Marie Smith' })).toBe('AS');
    expect(avatarText({ name: '!!!' })).toBe('?');
  });

  it('never throws on a malformed payload: non-string fields read as absent', () => {
    tagAc(AC_ONE_RULE);
    const weird = { name: 42, email: {}, avatarLabel: ['X'] } as unknown as Parameters<typeof avatarText>[0];
    expect(avatarText(weird)).toBe('?');
    const weirdLabel = { name: 'Sam', avatarLabel: 7 } as unknown as Parameters<typeof avatarText>[0];
    expect(avatarText(weirdLabel)).toBe('SA');
  });

  it('accepts accented letters typed in decomposed form', () => {
    tagAc(AC_NORMALIZE);
    // "E" + combining acute accent (U+0301) is how some keyboards and pastes arrive.
    expect(normalizeAvatarLabel('éw')).toBe('ÉW');
  });
});
