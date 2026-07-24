// Unit tests for spec-505 ac-4: internal/test accounts must not fire ad-platform
// conversions. Reuses the same "real users" definition as the Mixpanel profile sync
// (spec-297 dec-7, std-35 cl-31: email_domain === 'mindset.ai').
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { fireAllConversions, fireGoogleAdsConversion, type ConversionParams } from './conversion-apis.js';

const AC4 = 'mindset-prod/memex-building-itself/specs/spec-505/acs/ac-4';

// Enough env vars for all three fire* functions to pass their required-config gates,
// so a missing-credential no-op can't be mistaken for the internal-account exclusion.
const REQUIRED_ENV: Record<string, string> = {
  GOOGLE_ADS_CLIENT_ID: 'id',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_CUSTOMER_ID: 'cust',
  GOOGLE_ADS_CONVERSION_ACTION_ID: 'action',
  LINKEDIN_ACCESS_TOKEN: 'token',
  LINKEDIN_AD_ACCOUNT_ID: 'acct',
  LINKEDIN_CONVERSION_ID: 'conv',
  OPENAI_PIXEL_ID: 'pixel',
  OPENAI_PIXEL_API_KEY: 'key',
};

function paramsFor(email: string): ConversionParams {
  return {
    email,
    hashedEmail: 'hashed-email',
    eventId: 'evt-1',
    attribution: { gclid: 'g1', li_fat_id: 'l1', oppref: 'o1' },
    conversionDateTime: new Date(0).toISOString(),
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('fireAllConversions — internal account exclusion (spec-505 ac-4)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchSpy.mockRestore();
  });

  it('fires no network calls for an internal (mindset.ai) account', async () => {
    tagAc(AC4);
    fireAllConversions(paramsFor('qa@mindset.ai'));
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is case-insensitive on the email domain', async () => {
    tagAc(AC4);
    fireAllConversions(paramsFor('QA@MINDSET.AI'));
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not treat a lookalike domain as internal', async () => {
    tagAc(AC4);
    fireAllConversions(paramsFor('person@notmindset.ai'));
    await flush();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('fires network calls for a real external account', async () => {
    tagAc(AC4);
    fireAllConversions(paramsFor('person@example.com'));
    await flush();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('fireGoogleAdsConversion — Enhanced Conversions request contract (spec-505 issue-3)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(key, value);
    // First fetch = OAuth token exchange; second = the click-conversion upload.
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchSpy.mockRestore();
  });

  it('uploads to a currently-supported API version, not the sunset v17', async () => {
    await fireGoogleAdsConversion(paramsFor('person@example.com'));
    const uploadUrl = String(fetchSpy.mock.calls[1][0]);
    expect(uploadUrl).toContain('/v23/');
    expect(uploadUrl).not.toContain('/v17/');
  });

  it('sends the hashed email as a first-party userIdentifier, not a top-level hashedEmailAddress', async () => {
    await fireGoogleAdsConversion(paramsFor('person@example.com'));
    const body = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
    const conversion = body.conversions[0];
    expect(conversion.userIdentifiers).toEqual([
      { hashedEmail: 'hashed-email', userIdentifierSource: 'FIRST_PARTY' },
    ]);
    expect(conversion).not.toHaveProperty('hashedEmailAddress');
  });
});
