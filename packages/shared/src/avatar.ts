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

const LETTERS_ONLY = /^\p{L}+$/u;

/**
 * Normalise a nominated avatar label for storage: trimmed and upper-cased.
 * Absent or blank input returns null, meaning "use the automatic rule".
 * Throws AvatarLabelError for anything that is not one or two letters.
 */
export function normalizeAvatarLabel(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new AvatarLabelError();
  const trimmed = raw.trim();
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

export interface AvatarPerson {
  name?: string | null;
  email?: string | null;
  avatarLabel?: string | null;
}

/**
 * The letters an avatar shows: the nominated label when set; otherwise first + last
 * initial of the name (or email local part), or the first two letters of a one-word
 * name; "?" when there is nothing to derive from.
 */
export function avatarText(person: AvatarPerson): string {
  const label = person.avatarLabel?.trim();
  if (label) return label;
  const source = person.name?.trim() || person.email?.trim() || '';
  const parts = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return Array.from(parts[0]!).slice(0, 2).join('').toUpperCase();
  const first = Array.from(parts[0]!)[0]!;
  const last = Array.from(parts[parts.length - 1]!)[0]!;
  return (first + last).toUpperCase();
}
