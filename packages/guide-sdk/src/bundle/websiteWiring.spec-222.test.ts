// spec-222 t-10/t-15 — the engine↔public-endpoint wiring. Caught during live
// local testing: the bundle was passing authToken:()=>null and the engine's
// app-shaped paths (/voice/session, /voice/guide-chat, Authorization header) did
// not match the public endpoint (/guide/v1/voice + /chat, ?token= on both legs).
// This pins the website routing so the loop authenticates end to end. (ac-14)

import { describe, it, expect, vi, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { buildVoiceWsUrl } from '../orchestrator/voiceWsClient';
import { setGuideBackend } from '../backend';
import { callGuideLlmProxy, setGuideAuthToken } from '../guideLlmClient';

const AC_14 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-14';

afterEach(() => {
  // Reset to the app default so other suites are unaffected.
  setGuideBackend({ baseUrl: '/api' });
  setGuideAuthToken(null);
});

describe('spec-222: website engine wiring matches the /guide/v1 endpoint (ac-14)', () => {
  it('WS leg → ${backend}/voice?token= (website), /voice/session by default (app)', () => {
    tagAc(AC_14);
    // Website: backend base + injected voicePath '/voice', token on the query.
    expect(buildVoiceWsUrl('http://localhost:8090/guide/v1', 'tok123', 'http://localhost:8000', '/voice')).toBe(
      'ws://localhost:8090/guide/v1/voice?token=tok123',
    );
    // App default (no voicePath) is unchanged — /voice/session.
    expect(buildVoiceWsUrl('/api/acme/team', 'tok', 'http://localhost:5173')).toBe(
      'ws://localhost:5173/api/acme/team/voice/session?token=tok',
    );
  });

  it('SSE leg → ${backend}/chat?token= when the backend sets chatPath + tokenInQuery (website)', async () => {
    tagAc(AC_14);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    setGuideBackend({
      baseUrl: 'http://localhost:8090/guide/v1',
      chatPath: '/chat',
      tokenInQuery: true,
      fetchImpl,
    });
    setGuideAuthToken('tok123');

    // Drain the generator (the fake fetch is non-ok → it yields one error + returns).
    for await (const _ of callGuideLlmProxy({ messages: [], screenKey: null, screenRegistry: [], guideContext: [] })) {
      void _;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8090/guide/v1/chat?token=tok123');
  });

  it('SSE leg → ${baseUrl}/voice/guide-chat with NO query token by default (app)', async () => {
    tagAc(AC_14);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    setGuideBackend({ baseUrl: '/api/acme/team', fetchImpl }); // app defaults
    setGuideAuthToken('apptok');
    for await (const _ of callGuideLlmProxy({ messages: [], screenKey: null, screenRegistry: [], guideContext: [] })) {
      void _;
    }
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/acme/team/voice/guide-chat'); // no ?token= (Authorization header instead)
  });
});
