import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_CONSOLIDATED = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-3';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: () => {},
}));

vi.mock('../api/client', () => ({
  getSlackStatusApi: vi.fn(async () => []),
  disconnectSlackApi: vi.fn(async () => {}),
  listMcpTokensApi: vi.fn(async () => []),
  revokeMcpTokenApi: vi.fn(async () => {}),
}));

import { SettingsIntegrations } from './SettingsIntegrations';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/integrations']}>
      <SettingsIntegrations />
    </MemoryRouter>
  );
}

describe('spec-141 ac-3: consolidated Integrations page', () => {
  it('renders the page under a single Integrations heading', async () => {
    tagAc(AC_CONSOLIDATED);
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Integrations', level: 1 })
    ).toBeInTheDocument();
  });

  it('composes the Slack, MCP-tokens, and CLI-install sections', async () => {
    tagAc(AC_CONSOLIDATED);
    renderPage();
    // All three section headings render regardless of async load state.
    expect(await screen.findByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MCP Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Install Memex MCP' })).toBeInTheDocument();
  });

  it('composes the spec-201 Genesis-prompt section', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-201/acs/ac-21');
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Set up with one prompt' })
    ).toBeInTheDocument();
  });

  it('ac-6: composes the spec-201 "Install the AC emitter" section', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-201/acs/ac-6');
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Install the AC emitter' })
    ).toBeInTheDocument();
  });
});
