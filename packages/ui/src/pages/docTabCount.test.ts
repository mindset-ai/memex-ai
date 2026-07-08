import { describe, it, expect } from 'vitest';
import { countLabel } from './docTabCount';

describe('countLabel (spec-473 sub-tab content counts)', () => {
  it('renders a bare plural noun when the count is zero', () => {
    expect(countLabel(0, 'Decision', 'Decisions')).toBe('Decisions');
    expect(countLabel(0, 'AC', 'ACs')).toBe('ACs');
  });

  it('renders the singular noun + (1) when the count is one', () => {
    expect(countLabel(1, 'Decision', 'Decisions')).toBe('Decision (1)');
    expect(countLabel(1, 'AC', 'ACs')).toBe('AC (1)');
    expect(countLabel(1, 'Issue', 'Issues')).toBe('Issue (1)');
  });

  it('renders the plural noun + (n) when the count is greater than one', () => {
    expect(countLabel(3, 'Decision', 'Decisions')).toBe('Decisions (3)');
    expect(countLabel(12, 'Comment', 'Comments')).toBe('Comments (12)');
  });

  it('composes into a dual-entity label', () => {
    expect(`${countLabel(4, 'Decision', 'Decisions')} & ${countLabel(6, 'AC', 'ACs')}`).toBe(
      'Decisions (4) & ACs (6)',
    );
    expect(`${countLabel(0, 'Decision', 'Decisions')} & ${countLabel(6, 'AC', 'ACs')}`).toBe(
      'Decisions & ACs (6)',
    );
  });
});
