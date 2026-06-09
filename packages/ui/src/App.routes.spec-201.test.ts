import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-201 dec-1 (ac-7): the install/setup content lives ONLY on
// /settings/integrations. No net-new top-level /setup page, and the retired
// /installation + /install routes must redirect there (not serve content).
// A source-level guard is the right granularity: it pins the routing contract
// without booting the whole authenticated <App/> provider tree.
const AC_NO_NEW_ROUTE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-7';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8');

describe('spec-201 ac-7: no new setup/installation route; install content is on Integrations', () => {
  it('serves the install content from /settings/integrations', () => {
    tagAc(AC_NO_NEW_ROUTE);
    expect(appSource).toContain('path="/settings/integrations"');
    expect(appSource).toMatch(/path="\/settings\/integrations"[\s\S]*?SettingsIntegrations/);
  });

  it('redirects the retired /installation and /install routes there', () => {
    tagAc(AC_NO_NEW_ROUTE);
    expect(appSource).toMatch(
      /path="\/installation"\s+element=\{<Navigate to="\/settings\/integrations"/
    );
    expect(appSource).toMatch(
      /path="\/install"\s+element=\{<Navigate to="\/settings\/integrations"/
    );
  });

  it('introduces no /setup route', () => {
    tagAc(AC_NO_NEW_ROUTE);
    expect(appSource).not.toMatch(/path="\/?setup"/);
  });
});
