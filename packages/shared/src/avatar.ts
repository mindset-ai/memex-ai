// spec-574 — the one avatar rule.
//
// A person's avatar shows their nominated letters when they have set some, otherwise
// letters derived from their name (or email when they have no name). Every avatar in the
// UI renders through `avatarText`; nothing else derives initials. The server validates a
// nomination with `normalizeAvatarLabel`, and the profile form calls the same function, so
// the form refuses exactly what the server refuses.

/** At most this many letters are shown on an avatar. Matches the `users.avatar_label` CHECK. */
export const AVATAR_LABEL_MAX_LENGTH = 2;

export const AVATAR_LABEL_RULE = 'Avatar letters must be one or two letters (A–Z, including accented letters).';

export class AvatarLabelError extends Error {
  constructor() {
    super(AVATAR_LABEL_RULE);
    this.name = 'AvatarLabelError';
  }
}

// A letter, optionally followed by letters or combining marks (vowel signs such as the
// one in "कि" are marks). A mark on its own is not a letter.
const LETTERS_ONLY = /^\p{L}[\p{L}\p{M}]*$/u;

/**
 * Normalise a nominated avatar label for storage: trimmed and upper-cased.
 * Absent or blank input returns null, meaning "use the automatic rule".
 * Throws AvatarLabelError for anything that is not one or two letters.
 */
export function normalizeAvatarLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new AvatarLabelError();
  // NFC first: an accented letter typed or pasted as letter + combining mark is one letter.
  const trimmed = raw.normalize('NFC').trim();
  if (trimmed === '') return null;
  // Length is checked on the upper-cased value because upper-casing can lengthen a string
  // (ß → SS), and the stored value is what the database constraint sees.
  const upper = trimmed.toUpperCase();
  const length = Array.from(upper).length;
  if (!LETTERS_ONLY.test(upper) || length > AVATAR_LABEL_MAX_LENGTH) {
    throw new AvatarLabelError();
  }
  return upper;
}

export interface AvatarColor {
  /** Stored in users.avatar_color. Lower-case letters only (the column's CHECK). */
  key: string;
  /** Shown in the profile picker. */
  label: string;
  background: string;
  text: string;
}

// White letters on a mid-dark fill: legible in both themes, and each pair clears WCAG AA
// (4.5:1), which avatar.test.ts asserts. Adding a colour needs no migration. Removing one
// is safe too: anyone who had it renders the neutral default (avatarColorStyle).
export const AVATAR_COLORS: readonly AvatarColor[] = [
  { key: 'blue', label: 'Blue', background: '#2563EB', text: '#FFFFFF' },
  { key: 'indigo', label: 'Indigo', background: '#4F46E5', text: '#FFFFFF' },
  { key: 'violet', label: 'Violet', background: '#7C3AED', text: '#FFFFFF' },
  { key: 'pink', label: 'Pink', background: '#BE185D', text: '#FFFFFF' },
  { key: 'red', label: 'Red', background: '#DC2626', text: '#FFFFFF' },
  { key: 'orange', label: 'Orange', background: '#C2410C', text: '#FFFFFF' },
  { key: 'amber', label: 'Amber', background: '#B45309', text: '#FFFFFF' },
  { key: 'green', label: 'Green', background: '#15803D', text: '#FFFFFF' },
  { key: 'teal', label: 'Teal', background: '#0F766E', text: '#FFFFFF' },
  { key: 'slate', label: 'Slate', background: '#475569', text: '#FFFFFF' },
];

export const AVATAR_COLOR_RULE = `Avatar colour must be one of: ${AVATAR_COLORS.map((c) => c.key).join(', ')}.`;

export class AvatarColorError extends Error {
  constructor() {
    super(AVATAR_COLOR_RULE);
    this.name = 'AvatarColorError';
  }
}

const COLORS_BY_KEY: ReadonlyMap<string, AvatarColor> = new Map(AVATAR_COLORS.map((c) => [c.key, c]));

/**
 * Normalise a chosen avatar colour for storage: a palette key, lower-cased.
 * Absent or blank input returns null, meaning "the neutral default".
 * Throws AvatarColorError for anything that is not a palette key.
 */
export function normalizeAvatarColor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new AvatarColorError();
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  if (!COLORS_BY_KEY.has(key)) throw new AvatarColorError();
  return key;
}

/**
 * Inline style for an avatar's chosen colour, or null for the neutral default.
 * Never throws: an unknown, retired or malformed key is the neutral default.
 */
export function avatarColorStyle(key: unknown): { backgroundColor: string; color: string } | null {
  if (typeof key !== 'string') return null;
  const c = COLORS_BY_KEY.get(key);
  return c ? { backgroundColor: c.background, color: c.text } : null;
}

export interface AvatarPerson {
  name?: string | null;
  email?: string | null;
  avatarLabel?: string | null;
  avatarColor?: string | null;
}

// A field that is not a non-blank string reads as absent, so a malformed payload renders
// the automatic look instead of throwing during render.
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Letters, their combining marks, and digits only: punctuation ("O'Brien") and symbols
// ("👍 Bob") never become avatar letters, while a vowel sign stays with its letter.
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{M}\p{N}]/gu;

// User-perceived characters, so "कि" (letter + vowel sign) counts as one. Segmentation is
// only needed when the text carries combining marks; everything else is split by code point,
// which keeps the common case as cheap as it was (avatars render in long lists). The
// segmenter is stateless, so it is built once, on first need. Where Intl.Segmenter is
// unavailable, code points are the fallback.
const HAS_MARK = /\p{M}/u;
type GraphemeSegmenter = { segment(s: string): Iterable<{ segment: string }> };
let segmenter: GraphemeSegmenter | null | undefined;

function characters(s: string): string[] {
  if (!HAS_MARK.test(s)) return Array.from(s);
  if (segmenter === undefined) {
    const Segmenter = (Intl as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => GraphemeSegmenter }).Segmenter;
    segmenter = typeof Segmenter === 'function' ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/**
 * The letters an avatar shows: the nominated label when set; otherwise first + last
 * initial of the name (or email local part), or the first two letters of a one-word
 * name, counting letters and digits only; "?" when there is nothing to derive from.
 */
export function avatarText(person: AvatarPerson): string {
  const label = text(person.avatarLabel);
  if (label) return label;
  const source = text(person.name) || text(person.email);
  const parts = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    // A mark left without its base (the emoji before a variation selector was stripped)
    // is dropped, so "❤️ Alice" never shows a stray invisible mark.
    .map((part) => part.normalize('NFC').replace(NOT_LETTER_OR_DIGIT, '').replace(/^\p{M}+/u, ''))
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return characters(parts[0]!).slice(0, 2).join('').toUpperCase();
  const first = characters(parts[0]!)[0]!;
  const last = characters(parts[parts.length - 1]!)[0]!;
  return (first + last).toUpperCase();
}
