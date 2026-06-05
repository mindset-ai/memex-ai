import { describe, it, expect } from 'vitest';
import { roleClasses, membershipStatusClasses } from './roleStyles';

describe('roleClasses', () => {
  it('returns the success palette for administrator', () => {
    expect(roleClasses('administrator')).toContain('bg-status-success-bg');
    expect(roleClasses('administrator')).toContain('text-status-success-text');
  });

  it('returns the secondary palette for member', () => {
    expect(roleClasses('member')).toContain('bg-btn-secondary');
    expect(roleClasses('member')).toContain('text-secondary');
  });
});

describe('membershipStatusClasses', () => {
  it('returns the danger palette for disabled', () => {
    expect(membershipStatusClasses('disabled')).toContain('bg-status-danger-bg');
    expect(membershipStatusClasses('disabled')).toContain('text-status-danger-text');
  });

  it('returns the secondary palette for active', () => {
    expect(membershipStatusClasses('active')).toContain('bg-btn-secondary');
    expect(membershipStatusClasses('active')).toContain('text-secondary');
  });
});
