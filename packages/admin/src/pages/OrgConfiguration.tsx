import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { Tabs } from '../components/ui/Tabs';
import { useAuth } from '../components/AuthContext';
import { UsersTab } from '../components/account/UsersTab';
import { InvitesTab } from '../components/account/InvitesTab';
import { SettingsTab } from '../components/account/SettingsTab';
import { parseTenantFromPathname } from '../utils/tenantUrl';

const TAB_IDS = ['users', 'invites', 'settings'] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(s: string | null): s is TabId {
  return s === 'users' || s === 'invites' || s === 'settings';
}

// Single admin Org Configuration page (t-8 / t-11 of doc-15). Replaces the standalone
// /invites page and the t-6 standalone settings page. Three tabs: Users (default),
// Invites, Settings. Lives at /org; /account is kept as a redirect alias for old links.
export function OrgConfiguration() {
  const { session } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = isTabId(searchParams.get('tab')) ? (searchParams.get('tab') as TabId) : 'users';
  const [tab, setTab] = useState<TabId>(initialTab);
  const tenant = parseTenantFromPathname(location.pathname);
  const currentMembership = tenant
    ? session?.memberships.find((m) => m.slug === tenant.namespace && m.memexSlug === tenant.memex)
    : session?.memberships.find((m) => m.memexId === session?.currentMemexId);
  const isAdmin = currentMembership?.role === 'administrator';

  const onTabChange = useCallback(
    (id: string) => {
      if (!isTabId(id)) return;
      setTab(id);
      const next = new URLSearchParams(searchParams);
      next.set('tab', id);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // Keep state in sync if the URL changes externally (e.g., dropdown link with ?tab=invites)
  useEffect(() => {
    const t = searchParams.get('tab');
    if (isTabId(t) && t !== tab) setTab(t);
  }, [searchParams, tab]);

  if (!isAdmin) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <h1 className="text-xl font-semibold text-heading mb-2">Org configuration</h1>
        <p className="text-sm text-secondary">Only administrators can view this page.</p>
      </div>
    );
  }

  // spec-141 dec-5: title, tab bar, and tab content all share one max-width
  // container so the tab bar (and its bottom border) aligns with the content
  // beneath it. Previously the tab bar was full-bleed while content was
  // max-w-3xl mx-auto, so the bar floated left of the content it labelled.
  return (
    <div className="max-w-3xl mx-auto px-8 py-6" data-testid="org-config">
      <h1 className="text-xl font-semibold text-heading mb-4">Org configuration</h1>
      <Tabs
        tabs={[
          { id: 'users', label: 'Users' },
          { id: 'invites', label: 'Invites' },
          { id: 'settings', label: 'Settings' },
        ]}
        activeTab={tab}
        onChange={onTabChange}
      />
      <div className="pb-8">
        {tab === 'users' && <UsersTab onSwitchTab={onTabChange} />}
        {tab === 'invites' && <InvitesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
