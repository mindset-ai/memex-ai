// spec-226 t-6 / ac-6 — the designer-facing email-preview gallery.
// jsdom's hostname is "localhost", so emailPreviewEnabled() is true here (non-prod).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmailPreview } from './EmailPreview';

const AC_6 = 'mindset-prod/memex-building-itself/specs/spec-226/acs/ac-6';
const AC_7 = 'mindset-prod/memex-building-itself/specs/spec-226/acs/ac-7';

const SAMPLE_HTML = '<!doctype html><html><body>Confirm your email</body></html>';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/email-preview/send') && init?.method === 'POST') {
        // The server resolves the recipient from the session — the UI sends no
        // address, only the template name.
        return { ok: true, status: 200, json: async () => ({ sent: true, to: 'me@example.com' }) };
      }
      if (url.includes('/email-preview/templates')) {
        return { ok: true, status: 200, json: async () => ({ templates: ['welcome', 'verification'] }) };
      }
      return { ok: true, status: 200, text: async () => SAMPLE_HTML };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmailPreview gallery (spec-226 t-6 / ac-6)', () => {
  it('lists templates and renders the selected one in an iframe via srcDoc (not src)', async () => {
    tagAc(AC_6);
    render(
      <MemoryRouter>
        <EmailPreview />
      </MemoryRouter>,
    );

    // The picker is populated from the fetched template list.
    expect(await screen.findByTestId('tpl-welcome')).toBeTruthy();
    expect(screen.getByTestId('tpl-verification')).toBeTruthy();

    // The selected template's HTML is shown in an iframe via srcDoc — NOT src
    // (an iframe `src` to the Bearer-auth route would carry no token and 401).
    const iframe = await screen.findByTitle('Email preview');
    await waitFor(() =>
      expect(iframe.getAttribute('srcdoc')).toContain('Confirm your email'),
    );
    expect(iframe.getAttribute('src')).toBeNull();
  });

  it('"Send to my inbox" POSTs the template (no address field) and shows the result (ac-7)', async () => {
    tagAc(AC_7);
    render(
      <MemoryRouter>
        <EmailPreview />
      </MemoryRouter>,
    );

    const btn = await screen.findByTestId('send-to-me');
    fireEvent.click(btn);

    // Status reflects the server-resolved recipient (own email), proving the UI
    // carries no free-text address.
    const status = await screen.findByTestId('send-status');
    await waitFor(() => expect(status.textContent).toContain('Sent to me@example.com'));

    // The send POST carried the template name only — never a recipient address.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sendCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/email-preview/send'),
    );
    expect(sendCall).toBeTruthy();
    expect(String(sendCall?.[1]?.body)).not.toContain('@');
  });
});
