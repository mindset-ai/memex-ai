import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { SkillList } from './SkillList';
import type { SkillListItem } from '../api/skills';

// spec-300 t-6 ac-1: the Skills nav entry exists and the list renders from the API.
const AC1 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-1';
// spec-300 t-18 (issue-9): a newly-created skill appears on the list live — SkillList
// subscribes to the account-wide doc-change SSE stream, like StandardList.
const AC61 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-61';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const fetchSkillsMock = vi.fn();
vi.mock('../api/skills', async () => {
  const actual = await vi.importActual<typeof import('../api/skills')>('../api/skills');
  return { ...actual, fetchSkills: (...a: unknown[]) => fetchSkillsMock(...a) };
});

// The live-refresh SSE hook — mocked so we can assert SkillList subscribes and drive
// its callback. (Also keeps the other tests from opening a real EventSource in jsdom.)
const useDocChangeStreamMock = vi.fn();
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: (...a: unknown[]) => useDocChangeStreamMock(...a),
}));

// spec-300 t-15: the Skills page now docks the skills agent rail. These tests
// don't exercise the chat, so stub the rail's ChatProvider-dependent pieces (they'd
// otherwise throw "useChat must be used within ChatProvider") — mirrors the
// Standards list test. The rail wiring is covered by OpeningSkillsController /
// ChatContext.scoped / AgentIntro tests.
vi.mock('../components/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../components/chat/OpeningSkillsController', () => ({
  OpeningSkillsController: () => null,
}));

// PageHeader pulls AuthContext for the breadcrumb — stub like the Standards test.
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

function skill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    ref: 'ns/mx/skills/skill-1',
    handle: 'skill-1',
    name: 'Untitled skill',
    description: '',
    capabilities: { codebaseAccess: false, codeEditing: false, externalTools: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SkillList', () => {
  it('renders the Skills nav entry + list from the API (ac-1)', async () => {
    tagAc(AC1);

    // The nav entry: AppShell registers a Skills link and App.tsx routes it.
    const appShell = readFileSync(join(SRC_DIR, '../components/AppShell.tsx'), 'utf8');
    expect(appShell).toMatch(/to:\s*'\/skills'/);
    expect(appShell).toMatch(/label:\s*'Skills'/);
    const appSource = readFileSync(join(SRC_DIR, '../App.tsx'), 'utf8');
    expect(appSource).toContain('path="skills"');

    fetchSkillsMock.mockResolvedValueOnce([
      skill({ handle: 'skill-1', name: 'PR reviewer', description: 'Reviews PRs' }),
      skill({ handle: 'skill-2', name: 'Changelog writer' }),
    ]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );

    expect(await screen.findByText('PR reviewer')).toBeInTheDocument();
    expect(screen.getByText('Changelog writer')).toBeInTheDocument();
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
  });

  it('sorts skills alphabetically by name (ac-1)', async () => {
    tagAc(AC1);
    fetchSkillsMock.mockResolvedValueOnce([
      skill({ handle: 'skill-1', name: 'Zebra' }),
      skill({ handle: 'skill-2', name: 'Alpha' }),
    ]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );

    const cards = await screen.findAllByTestId('skill-card');
    expect(cards[0]).toHaveTextContent('Alpha');
    expect(cards[1]).toHaveTextContent('Zebra');
  });

  it('renders capability chips on a card (ac-1)', async () => {
    tagAc(AC1);
    fetchSkillsMock.mockResolvedValueOnce([
      skill({
        name: 'Coder',
        capabilities: { codebaseAccess: true, codeEditing: true, externalTools: false },
      }),
    ]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );

    await screen.findByText('Coder');
    expect(screen.getByText('Codebase access')).toBeInTheDocument();
    expect(screen.getByText('Code editing')).toBeInTheDocument();
    expect(screen.queryByText('External tools')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no skills (ac-1)', async () => {
    tagAc(AC1);
    fetchSkillsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('skills-empty')).toHaveTextContent(/No skills yet/i);
  });

  it('filters by the search box (ac-1)', async () => {
    tagAc(AC1);
    fetchSkillsMock.mockResolvedValueOnce([
      skill({ handle: 'skill-1', name: 'PR reviewer' }),
      skill({ handle: 'skill-2', name: 'Changelog writer' }),
    ]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );

    await screen.findByText('PR reviewer');
    fireEvent.change(screen.getByTestId('skills-search'), { target: { value: 'changelog' } });
    expect(screen.queryByText('PR reviewer')).not.toBeInTheDocument();
    expect(screen.getByText('Changelog writer')).toBeInTheDocument();
  });

  it('live-refreshes the list on a doc-change event so a new skill appears immediately (issue-9, ac-61)', async () => {
    tagAc(AC61);
    fetchSkillsMock.mockResolvedValue([skill({ handle: 'skill-1', name: 'PR reviewer' })]);

    render(
      <MemoryRouter>
        <SkillList />
      </MemoryRouter>,
    );
    await screen.findByText('PR reviewer');

    // SkillList subscribes to the account-wide doc-change stream (null docId) with a
    // refetch callback — mirroring StandardList, so a skill created via the agent /
    // MCP / another session shows up without a manual refresh.
    expect(useDocChangeStreamMock).toHaveBeenCalled();
    const [docId, onEvent] = useDocChangeStreamMock.mock.calls[0];
    expect(docId).toBeNull();
    expect(typeof onEvent).toBe('function');

    // Firing the stream callback re-fetches the list.
    const before = fetchSkillsMock.mock.calls.length;
    await act(async () => {
      onEvent();
    });
    await waitFor(() =>
      expect(fetchSkillsMock.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
