// spec-141 dec-3: the single consolidated Integrations surface. Open core —
// note this file is NOT under `.ee/`. It composes three sections that used to
// be three separate routes (/settings/integrations, /settings/tokens,
// /installation):
//   - <SlackIntegrationSection/>   — Enterprise (lives under components/.ee/)
//   - <DiscordIntegrationSection/> — Enterprise (lives under components/.ee/, spec-138)
//   - <McpTokensSection/>          — open core (MCP token management).
//   - <CliInstallSection/>         — open core (install instructions).
// The retired routes redirect here (see App.tsx).

import { SlackIntegrationSection } from '../components/.ee/SlackIntegrationSection';
import { DiscordIntegrationSection } from '../components/.ee/DiscordIntegrationSection';
import { McpTokensSection } from '../components/McpTokensSection';
import { CliInstallSection } from '../components/CliInstallSection';

export function SettingsIntegrations() {
  // AppShell's <main> is `overflow-hidden`, so each page owns its own scroll
  // container (same pattern as Standard.tsx).
  return (
    <div className="h-full overflow-y-auto" data-testid="integrations-scroll">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-14">
        <div>
          <h1 className="text-xl font-semibold mb-2 text-heading">Integrations</h1>
          <p className="text-sm text-secondary">
            Connect external services and tools so agents can act on your behalf.
          </p>
        </div>

        <SlackIntegrationSection />
        <DiscordIntegrationSection />
        <McpTokensSection />
        <CliInstallSection />
      </div>
    </div>
  );
}
