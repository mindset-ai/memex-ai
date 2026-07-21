import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ExploreCompanion } from './ExploreCompanion';

// spec-502 dec-7:
//   ac-16 — the companion renders a synopsis of the in-view entity + the CTA.
//   ac-17 — it re-renders that synopsis when the route changes, no "next" button.
//   ac-19 — aria-live region, non-focus-trapping, standing CTA persists.
const AC_COMPANION = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-16';
const AC_REACTS = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-17';
const AC_A11Y = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-19';

const NS = '/mindset-prod/memex-building-itself';

// A tiny harness: the companion plus buttons that navigate to different entities,
// so we can drive real route changes and assert the companion reacts.
function Harness({ onCreate }: { onCreate: () => void }) {
  function Nav() {
    const navigate = useNavigate();
    return (
      <div>
        <button onClick={() => navigate(`${NS}/specs/spec-482`)}>go-spec</button>
        <button onClick={() => navigate(`${NS}/standards/std-28`)}>go-standard</button>
      </div>
    );
  }
  return (
    <Routes>
      <Route
        path="*"
        element={
          <>
            <Nav />
            <ExploreCompanion onCreate={onCreate} />
          </>
        }
      />
    </Routes>
  );
}

function renderAt(path: string, onCreate = () => {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness onCreate={onCreate} />
    </MemoryRouter>,
  );
}

describe('spec-502 ExploreCompanion', () => {
  it('ac-16: renders a synopsis of the in-view entity and the CTA', () => {
    tagAc(AC_COMPANION);
    renderAt(`${NS}/specs/spec-482`);
    const synopsis = screen.getByTestId('explore-companion-synopsis');
    expect(synopsis.textContent).toContain('spec-482');
    expect(screen.getByTestId('create-your-own-memex-cta')).toHaveTextContent(
      'Create your own Memex',
    );
    // A screen-specific nudge motivates the CTA, and it changes per screen (ac-17).
    expect(screen.getByTestId('explore-companion-nudge').textContent).toContain('Spec');
  });

  it('ac-17: re-renders the synopsis when the route changes, with no "next" button', () => {
    tagAc(AC_REACTS);
    renderAt(`${NS}/specs/spec-482`);
    const before = screen.getByTestId('explore-companion-synopsis').textContent ?? '';
    expect(before).toContain('spec-482');

    // Navigate to a different entity — a route change is the only trigger.
    fireEvent.click(screen.getByText('go-standard'));

    const after = screen.getByTestId('explore-companion-synopsis').textContent ?? '';
    expect(after).toContain('std-28');
    expect(after).not.toEqual(before);

    // Ambient tour, not click-next: there is no Next/Continue affordance.
    expect(screen.queryByRole('button', { name: /next|continue|skip/i })).toBeNull();
  });

  it('ac-19: synopsis is an aria-live polite region and the panel is not a modal', () => {
    tagAc(AC_A11Y);
    renderAt(`${NS}/trails`);
    const synopsis = screen.getByTestId('explore-companion-synopsis');
    expect(synopsis).toHaveAttribute('aria-live', 'polite');
    // Non-trapping: it's a plain complementary aside, never a dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('explore-companion').tagName.toLowerCase()).toBe('aside');
  });

  it('ac-19: the CTA persists and stays actionable across context changes', () => {
    tagAc(AC_A11Y);
    const onCreate = vi.fn();
    renderAt(`${NS}/specs/spec-482`, onCreate);

    // CTA present on the first entity...
    expect(screen.getByTestId('create-your-own-memex-cta')).toBeInTheDocument();
    // ...and still present after navigating to another entity.
    fireEvent.click(screen.getByText('go-standard'));
    const cta = screen.getByTestId('create-your-own-memex-cta');
    expect(cta).toBeInTheDocument();
    fireEvent.click(cta);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
