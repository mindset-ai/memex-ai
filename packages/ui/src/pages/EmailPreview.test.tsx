// spec-226 t-6 / ac-6 — the designer-facing email-preview gallery.
// spec-493 t-2 — the gallery now lays the onboarding sequence out as a TIMELINE with
// per-email send conditions, keeping the non-onboarding templates in a separate list.
// jsdom's hostname is "localhost", so emailPreviewEnabled() is true here (non-prod).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmailPreview } from './EmailPreview';

const AC226 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-226/acs/ac-${n}`;
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-493/acs/ac-${n}`;

const SAMPLE_HTML = '<!doctype html><html><body>Confirm your email</body></html>';

// The /templates payload shape spec-493 introduced: one metadata object per template.
// Onboarding emails carry sequence:true + their send-condition facts; everything else
// is sequence:false and belongs in the flat grouped list.
const TEMPLATES_PAYLOAD = {
  perCohortCap: 2,
  templates: [
    {
      name: 'welcome',
      sequence: true,
      order: 0,
      dayOffset: 0,
      anchor: 'email verification',
      cohort: 'every verified signup',
      trigger: 'sent once when a user first verifies their email',
      branch: 'main',
      flagGated: false,
      commsKey: null,
    },
    {
      name: 'activation-connected-inactive',
      sequence: true,
      order: 1,
      dayOffset: 2,
      anchor: 'first mcp.connected',
      cohort: 'connected an agent, but no tool call and no spec yet',
      trigger: 'dwell timer after the user first connects their agent',
      branch: 'connected-inactive',
      flagGated: true,
      commsKey: 'activation.connected_inactive',
    },
    {
      name: 'activation-winback',
      sequence: true,
      order: 1,
      dayOffset: 3,
      anchor: 'email verification',
      cohort: 'verified, but never connected an agent',
      trigger: 'dwell timer after signup for users who never connect',
      branch: 'win-back',
      flagGated: true,
      commsKey: 'activation.signed_in_dormant',
    },
    {
      name: 'activation-verified-milestone',
      sequence: true,
      order: 2,
      dayOffset: null,
      anchor: 'first acceptance criterion verified',
      cohort: 'any user, once ever',
      trigger: 'fires when the user’s first AC is verified',
      branch: 'main',
      flagGated: true,
      commsKey: null,
    },
    {
      name: 'activation-connect-people',
      sequence: true,
      order: 3,
      dayOffset: 12,
      anchor: 'signup',
      cohort: 'every verified signup — independent of the cohort nudge',
      trigger: 'day-12 check-in; can arrive alongside a cohort email',
      branch: 'main',
      flagGated: true,
      commsKey: 'activation.connect_people',
    },
    { name: 'verification', sequence: false },
    { name: 'magic-link', sequence: false },
    { name: 'activation-signed-in-dormant', sequence: false },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/email-preview/send') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ sent: true, to: 'me@example.com' }) };
      }
      if (url.includes('/email-preview/templates')) {
        return { ok: true, status: 200, json: async () => TEMPLATES_PAYLOAD };
      }
      return { ok: true, status: 200, text: async () => SAMPLE_HTML };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <EmailPreview />
    </MemoryRouter>,
  );

describe('EmailPreview timeline (spec-493 t-2)', () => {
  it('shows the onboarding emails as a timeline in send order, not a flat tab strip (ac-1)', async () => {
    tagAc(AC(1));
    renderPage();

    const timeline = await screen.findByTestId('email-timeline');
    // Every onboarding email is on the timeline...
    for (const name of [
      'welcome',
      'activation-connected-inactive',
      'activation-winback',
      'activation-verified-milestone',
      'activation-connect-people',
    ]) {
      expect(within(timeline).getByTestId(`tpl-${name}`)).toBeTruthy();
    }
    // ...in send order (welcome → cohort nudge → milestone → day-12).
    const nodes = within(timeline)
      .getAllByTestId(/^tpl-/)
      .map((el) => el.getAttribute('data-testid'));
    const idx = (n: string) => nodes.indexOf(`tpl-${n}`);
    expect(idx('welcome')).toBeLessThan(idx('activation-connected-inactive'));
    expect(idx('activation-connected-inactive')).toBeLessThan(idx('activation-verified-milestone'));
    expect(idx('activation-verified-milestone')).toBeLessThan(idx('activation-connect-people'));
  });

  it('displays each email’s send condition in plain terms — day, cohort, trigger, flag (ac-2)', async () => {
    tagAc(AC(2));
    renderPage();

    const timeline = await screen.findByTestId('email-timeline');
    // welcome: Day 0, transactional (always sends — not behind the flag)
    const welcome = within(timeline).getByTestId('cond-welcome');
    expect(welcome.textContent).toContain('Day 0');
    expect(welcome.textContent).toMatch(/every verified signup/i);
    expect(welcome.textContent).toMatch(/always sends|transactional/i);

    // connect-people: Day 12 + flag-gated
    const connect = within(timeline).getByTestId('cond-activation-connect-people');
    expect(connect.textContent).toContain('Day 12');
    expect(connect.textContent).toMatch(/activation flag/i);

    // verified-milestone: event-driven, no fixed day
    const milestone = within(timeline).getByTestId('cond-activation-verified-milestone');
    expect(milestone.textContent).toMatch(/event-driven/i);
  });

  it('renders connected-inactive & win-back as parallel exclusive branches, milestone/connect on the spine (ac-12)', async () => {
    tagAc(AC(12));
    renderPage();

    const branches = await screen.findByTestId('cohort-branches');
    // both cohort emails sit inside the single parallel-branch slot
    expect(within(branches).getByTestId('tpl-activation-connected-inactive')).toBeTruthy();
    expect(within(branches).getByTestId('tpl-activation-winback')).toBeTruthy();
    // milestone + connect are NOT in the branch slot (they're on the main spine)
    expect(within(branches).queryByTestId('tpl-activation-verified-milestone')).toBeNull();
    expect(within(branches).queryByTestId('tpl-activation-connect-people')).toBeNull();
  });

  it('keeps non-onboarding templates in a separate grouped list, off the timeline (ac-5, ac-11)', async () => {
    tagAc(AC(5));
    tagAc(AC(11));
    renderPage();

    const others = await screen.findByTestId('other-emails');
    const timeline = screen.getByTestId('email-timeline');

    // system / superseded templates live in the grouped list...
    for (const name of ['verification', 'magic-link', 'activation-signed-in-dormant']) {
      expect(within(others).getByTestId(`tpl-${name}`)).toBeTruthy();
      // ...and never on the timeline
      expect(within(timeline).queryByTestId(`tpl-${name}`)).toBeNull();
    }
    // and the onboarding emails are NOT duplicated into the grouped list
    expect(within(others).queryByTestId('tpl-welcome')).toBeNull();
  });

  it('every email (timeline or list) stays clickable to its HTML preview; send-to-me still works (ac-4)', async () => {
    tagAc(AC(4));
    renderPage();

    // Clicking a timeline email renders its HTML in the iframe (srcDoc, not src).
    const timeline = await screen.findByTestId('email-timeline');
    fireEvent.click(within(timeline).getByTestId('tpl-activation-winback'));
    const iframe = await screen.findByTitle('Email preview');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Confirm your email'));
    expect(iframe.getAttribute('src')).toBeNull();

    // A non-onboarding email is equally clickable.
    const others = screen.getByTestId('other-emails');
    fireEvent.click(within(others).getByTestId('tpl-verification'));
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Confirm your email'));

    // Send-to-my-inbox still works for the current selection.
    fireEvent.click(screen.getByTestId('send-to-me'));
    const status = await screen.findByTestId('send-status');
    await waitFor(() => expect(status.textContent).toContain('Sent to me@example.com'));
  });
});

// spec-226 regressions — the original guarantees must survive the timeline rework.
describe('EmailPreview gallery (spec-226 t-6 / ac-6)', () => {
  it('renders the selected template in an iframe via srcDoc (not src)', async () => {
    tagAc(AC226(6));
    renderPage();

    const iframe = await screen.findByTitle('Email preview');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Confirm your email'));
    expect(iframe.getAttribute('src')).toBeNull();
  });

  it('"Send to my inbox" POSTs the template name only (no address field) (ac-7)', async () => {
    tagAc(AC226(7));
    renderPage();

    fireEvent.click(await screen.findByTestId('send-to-me'));
    const status = await screen.findByTestId('send-status');
    await waitFor(() => expect(status.textContent).toContain('Sent to me@example.com'));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sendCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/email-preview/send'),
    );
    expect(sendCall).toBeTruthy();
    expect(String(sendCall?.[1]?.body)).not.toContain('@');
  });
});
