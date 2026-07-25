// spec-502 t-5 (ac-1, dec-6): mount the Explore companion over the featured
// building-itself surface.
//
// The companion appears only when a wizard-eligible user is viewing the FEATURED
// demo Memex read-only (spec-500's `source==='featured'` membership) and the
// onboarding-wizard flag is on. It never shows on the user's own memexes or org
// memexes — those aren't the "see what good looks like" surface. Detection is by
// the generic `source==='featured'` provenance, hardcoding no specific Memex
// (std-22). The CTA opens the wizard.
//
// spec-508 Part 3 (dec-4, reversing dec-5): every landing over the featured Memex
// opens on the centered welcome that MORPHS into the companion. Dismissal is
// in-memory only, so a page refresh returns to the centered state.
//
// spec-508 activation gate: the welcome + companion are the UNACTIVATED-user nudge
// (the goal is to get them to land on the demo and install an MCP via the wizard).
// So we only surface it while the user has 0 specs AND no MCP connection, read from
// the journey-state milestones (spec-305). Once they author a spec or connect an
// agent they're past onboarding, and exploring the demo no longer nags them.

import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { WizardModal } from './WizardModal';
import { useOnboardingWizardEnabled } from './flag';
import { fetchJourneyStateApi } from '../api/journey';
import { getCachedJourneyState, setCachedJourneyState } from '../journeys/journeyStateCache';

// Motion rides in with this chunk — lazy-loaded for the featured-demo surface only.
const ExploreOnboarding = lazy(() =>
  import('./ExploreOnboarding').then((m) => ({ default: m.ExploreOnboarding })),
);

// Unactivated = no spec AND no MCP. Returns null while unknown so we never flash the
// welcome at an already-activated explorer before the journey read resolves.
function useUnactivated(enabled: boolean): boolean | null {
  const [unactivated, setUnactivated] = useState<boolean | null>(() => {
    const cached = getCachedJourneyState();
    return cached ? !cached.milestones.hasSpec && !cached.milestones.mcpConnected : null;
  });

  useEffect(() => {
    if (!enabled) return;
    const cached = getCachedJourneyState();
    if (cached) {
      setUnactivated(!cached.milestones.hasSpec && !cached.milestones.mcpConnected);
      return;
    }
    let alive = true;
    fetchJourneyStateApi()
      .then((s) => {
        setCachedJourneyState(s);
        if (alive) setUnactivated(!s.milestones.hasSpec && !s.milestones.mcpConnected);
      })
      // Fail closed: if we can't confirm they're unactivated, don't nag.
      .catch(() => alive && setUnactivated(false));
    return () => {
      alive = false;
    };
  }, [enabled]);

  return unactivated;
}

export function ExploreCompanionMount({
  namespace,
  memex,
}: {
  namespace: string;
  memex: string;
}) {
  const { session } = useAuth();
  const wizardEnabled = useOnboardingWizardEnabled();
  // The CTA opens the wizard as a modal over the live Memex (not a route change),
  // so the user keeps their place behind it and can back out cleanly.
  const [wizardOpen, setWizardOpen] = useState(false);

  // Is the tenant the user is viewing the featured demo Memex?
  const membership = session?.memberships.find(
    (m) => m.slug === namespace && (m.memexSlug === memex || (!m.memexSlug && memex === 'main')),
  );
  const onFeatured = !!session && wizardEnabled && membership?.source === 'featured';
  const unactivated = useUnactivated(onFeatured);

  // QA / demo escape hatch: `?welcome` on the featured surface forces the welcome
  // regardless of activation state, so it can be previewed on an already-activated
  // account. Never changes the ship default (an unactivated first-timer).
  const forced =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('welcome');

  // Only surface for an unactivated user (0 specs, no MCP) over the featured demo.
  if (!onFeatured || (!forced && unactivated !== true)) return null;

  return (
    <>
      <Suspense fallback={null}>
        <ExploreOnboarding
          memexId={membership!.memexId}
          memexName={membership!.memexName}
          onCreate={() => setWizardOpen(true)}
        />
      </Suspense>
      {wizardOpen && <WizardModal onClose={() => setWizardOpen(false)} />}
    </>
  );
}
