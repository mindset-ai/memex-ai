// spec-502 t-5 (ac-1, dec-6): mount the Explore companion over the featured
// building-itself surface.
//
// The companion appears only when a wizard-eligible user is viewing the FEATURED
// demo Memex read-only (spec-500's `source==='featured'` membership) and the
// onboarding-wizard flag is on. It never shows on the user's own memexes or org
// memexes — those aren't the "see what good looks like" surface. Detection is by
// the generic `source==='featured'` provenance, hardcoding no specific Memex
// (std-22). The CTA opens the wizard.

import { useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { ExploreCompanion } from './ExploreCompanion';
import { WizardModal } from './WizardModal';
import { useOnboardingWizardEnabled } from './flag';

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

  if (!session || !wizardEnabled) return null;

  // Is the tenant the user is viewing the featured demo Memex?
  const membership = session.memberships.find(
    (m) => m.slug === namespace && (m.memexSlug === memex || (!m.memexSlug && memex === 'main')),
  );
  if (membership?.source !== 'featured') return null;

  return (
    <>
      <ExploreCompanion memexId={membership.memexId} onCreate={() => setWizardOpen(true)} />
      {wizardOpen && <WizardModal onClose={() => setWizardOpen(false)} />}
    </>
  );
}
