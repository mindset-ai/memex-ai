import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AVATAR_COLORS, AVATAR_LABEL_MAX_LENGTH, normalizeAvatarLabel } from '@memex/shared';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Alert } from './ui/Alert';
import { Avatar } from './ui/Avatar';
import { useAuth } from './AuthContext';
import { updateAvatarApi } from '../api/client';

// spec-574 t-4 — the person's avatar: the letters it shows and its colour.
//
// Nothing chosen is the automatic look (letters derived from the name, the neutral
// colour), which is how every avatar looked before this section existed. The preview is
// the real Avatar component, so what is previewed is exactly what everyone else sees.
// Letters are validated with the same function the server uses, so Save is only enabled
// for a request the server will accept.

// null = "Default" (the neutral colour). Ordered as the picker shows them.
const PICKER_OPTIONS: { key: string | null; label: string }[] = [
  { key: null, label: 'Default' },
  ...AVATAR_COLORS.map((c) => ({ key: c.key, label: c.label })),
];

function validateLetters(raw: string): { value: string | null; error: string | null } {
  try {
    return { value: normalizeAvatarLabel(raw), error: null };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : 'Invalid avatar letters.' };
  }
}

export function ProfileAvatarSection() {
  const { token, user, updateSession } = useAuth();
  const persistedLabel = user?.avatarLabel ?? null;
  const persistedColor = user?.avatarColor ?? null;

  const [letters, setLetters] = useState(persistedLabel ?? '');
  const [color, setColor] = useState<string | null>(persistedColor);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { value: normalizedLetters, error: lettersError } = useMemo(() => validateLetters(letters), [letters]);
  const changed = normalizedLetters !== persistedLabel || color !== persistedColor;
  const canSave = !saving && !lettersError && changed;

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const session = await updateAvatarApi(token, { avatarLabel: normalizedLetters, avatarColor: color });
      updateSession(session);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your avatar. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [canSave, token, normalizedLetters, color, updateSession]);

  const selectedIndex = Math.max(
    0,
    PICKER_OPTIONS.findIndex((o) => o.key === color),
  );

  const pick = (index: number) => {
    const option = PICKER_OPTIONS[index];
    if (!option) return;
    setColor(option.key);
    setSaved(false);
    swatchRefs.current[index]?.focus();
  };

  // A radio group: arrow keys move the selection, Home/End jump to the ends.
  const onPickerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = PICKER_OPTIONS.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: selectedIndex === last ? 0 : selectedIndex + 1,
      ArrowDown: selectedIndex === last ? 0 : selectedIndex + 1,
      ArrowLeft: selectedIndex === 0 ? last : selectedIndex - 1,
      ArrowUp: selectedIndex === 0 ? last : selectedIndex - 1,
      Home: 0,
      End: last,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    pick(next);
  };

  return (
    <section className="space-y-6" data-testid="profile-avatar">
      <div>
        <h3 className="text-sm font-semibold text-heading">Your avatar</h3>
        <p className="text-sm text-secondary mt-1">
          How you appear to everyone in the workspace wherever you show up: on Specs, in
          comments, and on Pulse.
        </p>
      </div>

      {error && (
        <Alert variant="danger" size="md">
          {error}
        </Alert>
      )}

      <div className="flex items-center gap-4">
        <div data-testid="profile-avatar-preview" aria-label="Avatar preview">
          <Avatar
            person={{
              name: user?.name,
              email: user?.email,
              // Preview the letters as they will be saved; while they are invalid, show
              // the automatic ones rather than something the server would refuse.
              avatarLabel: lettersError ? null : normalizedLetters,
              avatarColor: color,
            }}
            size="lg"
          />
        </div>
        <p className="text-xs text-secondary">This is how others see you.</p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-secondary">
          Letters
          <div className="flex gap-2 mt-1 items-center">
            <Input
              value={letters}
              maxLength={AVATAR_LABEL_MAX_LENGTH}
              onChange={(e) => {
                setLetters(e.target.value);
                setSaved(false);
              }}
              placeholder="Automatic"
              aria-invalid={lettersError ? true : undefined}
              className="max-w-24"
              data-testid="profile-avatar-letters"
            />
            {letters.trim() !== '' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setLetters('');
                  setSaved(false);
                }}
              >
                Use automatic initials
              </Button>
            )}
          </div>
        </label>
        {lettersError ? (
          <p role="alert" className="text-xs text-status-danger-text">
            {lettersError}
          </p>
        ) : (
          <p className="text-xs text-secondary">
            One or two letters. Leave empty to use the initials of your name.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <span id="profile-avatar-color-label" className="block text-sm text-secondary">
          Colour
        </span>
        <div
          role="radiogroup"
          aria-labelledby="profile-avatar-color-label"
          className="flex flex-wrap gap-2"
          onKeyDown={onPickerKeyDown}
          data-testid="profile-avatar-colors"
        >
          {PICKER_OPTIONS.map((option, index) => {
            const selected = index === selectedIndex;
            const swatch = AVATAR_COLORS.find((c) => c.key === option.key);
            return (
              <button
                key={option.key ?? 'default'}
                ref={(el) => {
                  swatchRefs.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={option.label}
                title={option.label}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(index)}
                style={swatch ? { backgroundColor: swatch.background } : undefined}
                className={`h-7 w-7 rounded-full border ${
                  swatch ? 'border-transparent' : 'bg-btn-secondary border-divider'
                } ${selected ? 'ring-2 ring-offset-2 ring-offset-panel ring-edge-strong' : ''}`}
              />
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={!canSave} data-testid="profile-avatar-save">
          {saving ? 'Saving…' : 'Save avatar'}
        </Button>
        {saved && <span className="text-xs text-status-success-text">Avatar saved.</span>}
      </div>
    </section>
  );
}
