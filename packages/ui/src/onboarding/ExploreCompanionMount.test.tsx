import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-502 ac-1: the wizard's step 0 — the Explore companion appears over the
// featured building-itself surface (and only there, when the flag is on).
const AC_SEE_IT = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-1';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

// Stub the wizard modal — the mount's job is to OPEN it on the CTA (not to
// navigate). Its own behaviour is covered in Wizard.test.tsx / WizardModal.
vi.mock('./WizardModal', () => ({
  WizardModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="wizard-modal">
      <button data-testid="wizard-modal-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

let hiddenFeatures: string[] = [];
const FEATURED = {
  kind: 'team',
  slug: 'mindset-prod',
  memexSlug: 'memex-building-itself',
  memexId: 'mx-featured',
  name: 'memex-building-itself',
  source: 'featured',
};
const PERSONAL = {
  kind: 'personal',
  slug: 'alice',
  memexSlug: 'personal',
  memexId: 'mx-personal',
  name: 'Alice',
};
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { email: 'a@b.co' }, memberships: [PERSONAL, FEATURED], hiddenFeatures },
  }),
}));

import { ExploreCompanionMount } from './ExploreCompanionMount';

function renderMount(namespace: string, memex: string) {
  return render(
    <MemoryRouter initialEntries={[`/${namespace}/${memex}/trails`]}>
      <ExploreCompanionMount namespace={namespace} memex={memex} />
    </MemoryRouter>,
  );
}

describe('spec-502 ac-1: ExploreCompanionMount', () => {
  beforeEach(() => {
    hiddenFeatures = [];
    navigate.mockClear();
  });

  it('shows the companion over the featured demo Memex', () => {
    tagAc(AC_SEE_IT);
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.getByTestId('explore-companion')).toBeInTheDocument();
  });

  it('does NOT show on the user\'s own personal Memex', () => {
    tagAc(AC_SEE_IT);
    renderMount('alice', 'personal');
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });

  it('does NOT show when the kill-switch flag is set', () => {
    tagAc(AC_SEE_IT);
    hiddenFeatures = ['onboarding-wizard'];
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });

  it('the CTA opens the wizard as a modal (no route change)', () => {
    tagAc(AC_SEE_IT);
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('wizard-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('create-your-own-memex-cta'));
    expect(screen.getByTestId('wizard-modal')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('the modal is closeable — dismissing it returns to Explore', () => {
    tagAc(AC_SEE_IT);
    renderMount('mindset-prod', 'memex-building-itself');
    fireEvent.click(screen.getByTestId('create-your-own-memex-cta'));
    fireEvent.click(screen.getByTestId('wizard-modal-close'));
    expect(screen.queryByTestId('wizard-modal')).toBeNull();
    expect(screen.getByTestId('explore-companion')).toBeInTheDocument();
  });
});
