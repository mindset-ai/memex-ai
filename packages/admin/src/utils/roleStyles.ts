// Canonical role/membership-status → color mapping for the Org-members UI. Mirrors
// the shape of statusStyles.ts so adding a new role variant happens in one place.
//
// Usage:
//   <span className={`text-xs px-2 py-0.5 rounded ${roleClasses(member.role)}`}>{member.role}</span>
//
// Replaces inline ternaries like
//   isAdmin ? 'bg-status-success-bg text-status-success-text' : 'bg-btn-secondary text-secondary'
// across account/UsersTab.tsx, account/InvitesTab.tsx, account/SettingsTab.tsx.
//
// Per t-11 of doc-15 the role enum renamed from `'user'` → `'member'`. The union
// stays narrow on the new value; the styling map's fallback handles legacy
// payloads silently.

export type Role = 'member' | 'administrator';
export type MembershipStatus = 'active' | 'disabled';

const ROLE_CLASSES: Record<Role, string> = {
  administrator: 'bg-status-success-bg text-status-success-text',
  member: 'bg-btn-secondary text-secondary',
};

const STATUS_CLASSES: Record<MembershipStatus, string> = {
  active: 'bg-btn-secondary text-secondary',
  disabled: 'bg-status-danger-bg text-status-danger-text',
};

export function roleClasses(role: Role): string {
  return ROLE_CLASSES[role] ?? ROLE_CLASSES.member;
}

export function membershipStatusClasses(status: MembershipStatus): string {
  return STATUS_CLASSES[status] ?? STATUS_CLASSES.active;
}
