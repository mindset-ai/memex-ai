import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
// `?raw` source imports (house pattern, see PromptButton.test.tsx) — keeps the
// assertion tsc-friendly without @types/node. The import paths themselves are
// part of the assertion: the Slack section resolves from a `.ee/` path.
import slackSectionSource from '../components/.ee/SlackIntegrationSection.tsx?raw';
import consolidatedPageSource from './SettingsIntegrations.tsx?raw';
import appSource from '../App.tsx?raw';

// spec-141 ac-4: the consolidation must NOT move EE code across the license
// line. The Slack section stays behind the `.ee` marker; the consolidated
// parent page is open core and merely composes it; the retired routes redirect.
const AC_EE_BOUNDARY = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-4';

describe('spec-141 ac-4: integrations consolidation respects the .ee line', () => {
  it('Slack integration UI lives behind the .ee license marker', () => {
    tagAc(AC_EE_BOUNDARY);
    // The file resolved from a `.ee/` path (the import above) and carries the
    // Enterprise license header.
    expect(slackSectionSource.length).toBeGreaterThan(0);
    expect(slackSectionSource).toMatch(/Memex Enterprise License|ENTERPRISE EDITION/);
  });

  it('the open-core Integrations page composes the EE Slack section from behind the marker', () => {
    tagAc(AC_EE_BOUNDARY);
    // The parent page imports Slack from a `.ee/` path rather than inlining EE
    // code — so no EE logic lives in this open-core file.
    expect(consolidatedPageSource).toMatch(/components\/\.ee\/SlackIntegrationSection/);
    expect(consolidatedPageSource).toMatch(/McpTokensSection/);
    expect(consolidatedPageSource).toMatch(/CliInstallSection/);
  });

  it('retires /settings/tokens and /installation by redirecting to the consolidated route', () => {
    tagAc(AC_EE_BOUNDARY);
    expect(appSource).toMatch(
      /path="\/settings\/tokens"[\s\S]*?Navigate to="\/settings\/integrations"/
    );
    expect(appSource).toMatch(
      /path="\/installation"[\s\S]*?Navigate to="\/settings\/integrations"/
    );
  });
});
