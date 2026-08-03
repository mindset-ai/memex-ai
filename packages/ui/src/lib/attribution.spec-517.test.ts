// Tests for spec-517: fireSignupConversion routes a new-account conversion to
// every channel (dataLayer→GTM, GA4 gtag, OpenAI oaiq), never throws when a tag
// is missing, and fires nothing for internal (@mindset.ai) sign-ups.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { fireSignupConversion } from './attribution';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-517/acs/ac-${n}`;

type W = {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  oaiq?: (...args: unknown[]) => void;
};

describe('fireSignupConversion (spec-517)', () => {
  const w = window as unknown as W;
  let dataLayer: unknown[];
  let gtag: ReturnType<typeof vi.fn>;
  let oaiq: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataLayer = [];
    w.dataLayer = dataLayer;
    gtag = vi.fn();
    oaiq = vi.fn();
    w.gtag = gtag;
    w.oaiq = oaiq;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete w.gtag;
    delete w.oaiq;
    delete w.dataLayer;
    warn.mockRestore();
  });

  it('sends the GA4 sign_up_completed event with event_id + attribution (ac-3)', () => {
    tagAc(AC(3));
    fireSignupConversion('evt-1', 'person@example.com', { gclid: 'g1' });
    expect(gtag).toHaveBeenCalledWith(
      'event',
      'sign_up_completed',
      expect.objectContaining({ event_id: 'evt-1', gclid: 'g1' }),
    );
    // dataLayer push (GTM → Google Ads + LinkedIn) still happens alongside GA4.
    expect(dataLayer).toContainEqual(
      expect.objectContaining({ event: 'sign_up_completed', event_id: 'evt-1', gclid: 'g1' }),
    );
  });

  it('sends the OpenAI registration_completed event with the shared event_id (ac-4)', () => {
    tagAc(AC(4));
    fireSignupConversion('evt-2', 'person@example.com', null);
    expect(oaiq).toHaveBeenCalledWith(
      'track',
      'registration_completed',
      expect.objectContaining({ event_id: 'evt-2' }),
    );
  });

  it('never throws and logs an observable skip when a tag is absent (ac-5)', () => {
    tagAc(AC(5));
    delete w.gtag;
    delete w.oaiq;
    expect(() => fireSignupConversion('evt-3', 'person@example.com', null)).not.toThrow();
    // A missing tag is warned about, not silently dropped — so it can't masquerade
    // as zero conversions.
    expect(warn).toHaveBeenCalled();
    // The GTM path is independent of gtag/oaiq, so it still fires.
    expect(dataLayer).toContainEqual(
      expect.objectContaining({ event: 'sign_up_completed', event_id: 'evt-3' }),
    );
  });

  it('fires nothing on any channel for an internal @mindset.ai account (ac-7)', () => {
    tagAc(AC(7));
    fireSignupConversion('evt-4', 'qa@mindset.ai', { gclid: 'g1' });
    expect(gtag).not.toHaveBeenCalled();
    expect(oaiq).not.toHaveBeenCalled();
    expect(dataLayer).toHaveLength(0);
  });

  it('treats the internal domain case-insensitively (ac-7)', () => {
    tagAc(AC(7));
    fireSignupConversion('evt-5', 'QA@MINDSET.AI', null);
    expect(gtag).not.toHaveBeenCalled();
    expect(oaiq).not.toHaveBeenCalled();
    expect(dataLayer).toHaveLength(0);
  });

  it('does not treat a lookalike domain as internal (ac-7)', () => {
    tagAc(AC(7));
    fireSignupConversion('evt-6', 'person@notmindset.ai', null);
    expect(gtag).toHaveBeenCalled();
    expect(oaiq).toHaveBeenCalled();
    expect(dataLayer).toHaveLength(1);
  });
});
