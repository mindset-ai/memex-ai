import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { listTeamAvatarChoicesApi } from '../api/client';
import { useAuth } from './AuthContext';

// spec-574 — the people's avatar choices for surfaces that hold only a user id.
//
// Comments and Pulse rows carry an author/actor id and a stamped name, but not the
// person's chosen letters or colour. This provider reads the team's avatar choices once per
// tenant (only members who made one, ids and choices only) and exposes id → choices, so
// those avatars look the same as everywhere else.
//
// Failure is always the automatic look, never an error: the context default is an empty
// roster, so a component rendered outside the provider (a public Memex viewed anonymously,
// a personal Memex, /home, a component test) derives letters from the name and makes no
// request. The provider is only ENABLED where the roster endpoint will answer (an org
// member of a team Memex), so it never produces a refused request in the console.

export interface AvatarChoice {
  avatarLabel: string | null;
  avatarColor: string | null;
}

const EMPTY: ReadonlyMap<string, AvatarChoice> = new Map();

const AvatarRosterContext = createContext<ReadonlyMap<string, AvatarChoice>>(EMPTY);

interface AvatarRosterProviderProps {
  /** True only where GET team/avatars will answer: an org member of a team Memex. */
  enabled: boolean;
  /** Changes when the tenant changes, so a Memex switch refetches that Memex's roster. */
  tenantKey: string;
  children: ReactNode;
}

export function AvatarRosterProvider({ enabled, tenantKey, children }: AvatarRosterProviderProps) {
  const { token, user } = useAuth();
  const [roster, setRoster] = useState<ReadonlyMap<string, AvatarChoice>>(EMPTY);

  useEffect(() => {
    setRoster(EMPTY);
    if (!enabled || !token) return;
    let cancelled = false;
    listTeamAvatarChoicesApi(token)
      .then((members) => {
        if (cancelled || !Array.isArray(members)) return;
        const next = new Map<string, AvatarChoice>();
        for (const m of members) {
          if (!m || typeof m.userId !== 'string') continue;
          next.set(m.userId, { avatarLabel: m.avatarLabel ?? null, avatarColor: m.avatarColor ?? null });
        }
        setRoster(next);
      })
      .catch(() => {
        // Deliberately silent: without the roster, avatars show the automatic look, which
        // is what they showed before this feature. Nothing here is actionable by a user.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, token, tenantKey]);

  // The signed-in user's own choices come from their session, so a change they make on
  // the profile page shows on their comments and Pulse avatars at once.
  const ownId = user?.id;
  const ownLabel = user?.avatarLabel ?? null;
  const ownColor = user?.avatarColor ?? null;
  const value = useMemo(() => {
    if (!ownId) return roster;
    const next = new Map(roster);
    next.set(ownId, { avatarLabel: ownLabel, avatarColor: ownColor });
    return next;
  }, [roster, ownId, ownLabel, ownColor]);

  return <AvatarRosterContext.Provider value={value}>{children}</AvatarRosterContext.Provider>;
}

/** The person's avatar choices, or null when unknown (render the automatic look). */
export function useAvatarChoice(userId: string | null | undefined): AvatarChoice | null {
  const roster = useContext(AvatarRosterContext);
  if (!userId) return null;
  return roster.get(userId) ?? null;
}
