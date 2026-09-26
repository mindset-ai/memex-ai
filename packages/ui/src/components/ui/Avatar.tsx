import { avatarColorStyle, avatarText, type AvatarPerson } from '@memex/shared';

// spec-574 — the ONE person avatar. Every surface that shows a person as a letter
// avatar renders this component, so a person looks the same everywhere: their
// nominated letters (else letters derived from their name) on their chosen palette
// colour (else the neutral default). Nothing else in the UI derives initials; the
// avatar guard test enforces that.
//
// Rendering must never throw, whatever the payload: a session cached before these
// fields existed, an older server mid-rollout, or a colour since retired from the
// palette all render the automatic look.

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: 'w-4 h-4 text-[8px]',
  sm: 'w-5 h-5 text-[9px]',
  md: 'w-6 h-6 text-[10px]',
  lg: 'w-8 h-8 text-xs',
};

const NEUTRAL_CLASSES = 'bg-btn-secondary text-secondary border-divider';

interface AvatarProps {
  person: AvatarPerson;
  size?: AvatarSize;
  /** Layout extras from the call site (e.g. a ring for a stacked cluster). Never colour or text. */
  className?: string;
  /**
   * True when the person's name is already rendered next to the avatar, so assistive
   * technology does not read it twice. Otherwise the avatar is labelled with the name.
   */
  decorative?: boolean;
}

export function Avatar({ person, size = 'md', className = '', decorative = false }: AvatarProps) {
  const text = avatarText(person);
  const colorStyle = avatarColorStyle(person.avatarColor);
  const name = person.name?.trim() || person.email?.trim() || undefined;
  const a11y = decorative || !name ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name };
  return (
    <span
      data-testid="avatar"
      data-avatar-color={colorStyle ? person.avatarColor ?? undefined : 'default'}
      title={name}
      style={colorStyle ?? undefined}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full border font-medium leading-none ${SIZE_CLASSES[size] ?? SIZE_CLASSES.md} ${colorStyle ? 'border-transparent' : NEUTRAL_CLASSES} ${className}`}
      {...a11y}
    >
      {text}
    </span>
  );
}
