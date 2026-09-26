import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { AvatarLabelError, avatarText, normalizeAvatarLabel } from './avatar.js';

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
