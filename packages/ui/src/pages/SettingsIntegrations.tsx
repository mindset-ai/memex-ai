// spec-141 dec-3: the single consolidated Integrations surface. Open core —
// note this file is NOT under `.ee/`. It composes three sections that used to
// be three separate routes (/settings/integrations, /settings/tokens,
// /installation):
//   - <SlackIntegrationSection/>   — Enterprise (lives under components/.ee/)
//   - <DiscordIntegrationSection/> — Enterprise (lives under components/.ee/, spec-138)
//   - <DesktopMcpSection/>         — open core (spec-304 t-55: in-app MCP install; desktop-shell only).
//   - <AgentSetupSection/>         — open core (spec-452: the ONE tabbed, per-client setup surface;
//                                     supersedes + merges the old CliInstallSection + GenesisPromptSection).
//   - <McpTokensSection/>          — open core (MCP token management).
//   - <AcEmitterSection/>          — open core (spec-201: install the AC emitter).
// The retired routes redirect here (see App.tsx).

import { SlackIntegrationSection } from '../components/.ee/SlackIntegrationSection';
import { DiscordIntegrationSection } from '../components/.ee/DiscordIntegrationSection';
import { DesktopMcpSection } from '../components/DesktopMcpSection';
import { AgentSetupSection } from '../components/AgentSetupSection';
import { McpTokensSection } from '../components/McpTokensSection';
import { AcEmitterSection } from '../components/AcEmitterSection';
import { useScrollToHash } from '../hooks/useScrollToHash';

export function SettingsIntegrations() {
  // Deep-link from the native MCP pill / tray item lands on
  // …/settings/integrations#desktop-mcp — scroll that section into view on first
  // navigation (issue-25), not only after a second click.
  useScrollToHash();
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
        {/* Desktop-shell only (spec-304 t-55): self-hides in a plain browser. */}
        <DesktopMcpSection />
        {/* spec-452: the one tabbed, per-client setup surface (primary). */}
        <AgentSetupSection />
        <McpTokensSection />
        <AcEmitterSection />
      </div>
    </div>
  );
}
