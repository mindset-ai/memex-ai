// spec-423 (dec-7) — FacetPills unit tests. UNTAGGED (presentation); the end-to-end
// pill rendering is covered by the Playwright journey (std-28).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FacetPills } from './FacetPills';

describe('FacetPills', () => {
  it('renders one pill per facet key', () => {
    render(<FacetPills facetKeys={['security', 'db-migrations']} />);
    const pills = screen.getAllByTestId('facet-pill');
    expect(pills).toHaveLength(2);
    expect(pills.map((p) => p.getAttribute('data-facet-key'))).toEqual(['security', 'db-migrations']);
    expect(screen.getByText('security')).toBeInTheDocument();
  });

  it('renders nothing when there are no facets (no ballot / governs-nothing)', () => {
    const { container } = render(<FacetPills facetKeys={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('facet-pills')).toBeNull();
  });

  it('renders nothing for undefined / null facetKeys (legacy payloads)', () => {
    const { container } = render(<FacetPills facetKeys={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
