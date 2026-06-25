// spec-197 Slice 2 wiring (t-2 / t-3 / t-4) — Specky filling spec-190's voice
// surface. The standalone renderer + idle-only/no-Lottie guarantees are covered by
// Specky.test.tsx (t-5); here we assert the WIRING:
//   - entry doorway shows the ANIMATED (alive) Specky, not the neutral glyph
//     (dec-2 revised / ac-8, ac-1 entry side);
//   - one click opens the session and surfaces the ANIMATED Specky in the pill
//     (dec-1 / ac-2, ac-9, ac-1 pill side);
//   - the SAME character serves both surfaces (ac-1);
//   - where the guide is absent (unregistered screen), no Specky appears (ac-6).
//
// spec-222 (ac-9): moved into guide-sdk with the engine, so it no longer imports
// the app-only VoiceLayer (react-router + @memex/shared). A tiny in-test harness
// replicates VoiceLayer's render decision, gating the icon on an injected path
// (the same seam the real VoiceLayer reads via resolveScreenKey). Every assertion +
// tagAc is preserved.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { VoiceSessionProvider, useVoiceSession } from './VoiceSessionContext';
import { VoiceIcon } from './VoiceIcon';
import { VoiceSessionPill } from './VoiceSessionPill';
import { Specky } from '../components/Specky';

const AC_IDENTITY = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-1';
const AC_CLICK_OPENS = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-2';
const AC_ABSENT_WHEN_DISABLED = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-6';
const AC_QUIET_ENTRY = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-8';
const AC_ONE_GESTURE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-9';

const REGISTERED = '/ns/mx/specs';
const UNREGISTERED = '/ns/mx/not-a-registered-screen';

const ANCHOR = 'fixed bottom-6 right-6 z-50';

function isRegistered(path: string): boolean {
  return !path.includes('not-a-registered-screen');
}

// In-test VoiceLayer: pill when active, else the in-view icon ONLY on a registered
// screen — mirrors the real component's decision tree without react-router.
function VoiceLayerHarness({ path }: { path: string }): React.JSX.Element | null {
  const session = useVoiceSession();
  if (session.status === 'active') {
    return (
      <div className={ANCHOR}>
        <VoiceSessionPill />
      </div>
    );
  }
  if (!isRegistered(path)) return null;
  return (
    <div className={ANCHOR}>
      <VoiceIcon mark={<Specky size={40} />} />
    </div>
  );
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
}

function renderVoice(initialPath = REGISTERED) {
  return render(
    <VoiceSessionProvider
      getUserMedia={async () => fakeStream()}
      detectMic={() => true}
      earcons={{ play: () => {}, dispose: () => {} }}
    >
      <VoiceLayerHarness path={initialPath} />
    </VoiceSessionProvider>,
  );
}

async function startSession(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Ask Specky'));
  });
}

/** Decode an inlined data: URI svg to its markup; for an /assets/ file URL
 *  (asset over the inline limit) return the URL so callers can still match on
 *  the filename. Both Specky variants are < 4KB today, so the data path runs. */
function svgOf(img: Element | null | undefined): string {
  const src = img?.getAttribute('src') ?? '';
  return src.startsWith('data:') ? decodeURIComponent(src.slice(src.indexOf(',') + 1)) : src;
}

function isStatic(img: Element | null | undefined): boolean {
  const m = svgOf(img);
  return m.startsWith('/') || m.includes('specky-static')
    ? m.includes('specky-static')
    : m.includes('M 78 300 L 78 122') && !m.includes('@keyframes');
}

function isAnimated(img: Element | null | undefined): boolean {
  const m = svgOf(img);
  return m.startsWith('/') || m.includes('specky-static')
    ? m.includes('specky') && !m.includes('specky-static')
    : m.includes('@keyframes');
}

beforeEach(() => vi.clearAllMocks());

describe('spec-197 wiring — Specky in the spec-190 voice surface', () => {
  it('the in-view entry doorway shows the ANIMATED (alive) Specky, not the neutral glyph (ac-8 / ac-1 entry)', () => {
    tagAc(AC_QUIET_ENTRY);
    tagAc(AC_IDENTITY);
    renderVoice(REGISTERED);
    const affordance = screen.getByLabelText('Ask Specky');
    const img = affordance.querySelector('img');
    // Specky is the identity (an <img>), replacing the placeholder sound-wave glyph.
    expect(img).not.toBeNull();
    expect(affordance.querySelector('svg')).toBeNull(); // the neutral DefaultMark <svg> is gone
    // ...and it is the ANIMATED idle-loop variant — an alive, inviting doorway
    // (dec-2 revised 2026-06-08; the static frame is now used only for the
    // reduced-motion freeze inside the SVG, not as a separate quiet doorway).
    expect(isAnimated(img)).toBe(true);
    expect(isStatic(img)).toBe(false);
  });

  it('one click opens the session AND surfaces the ANIMATED Specky avatar in the pill (ac-2 / ac-9 / ac-1 pill)', async () => {
    tagAc(AC_CLICK_OPENS);
    tagAc(AC_ONE_GESTURE);
    tagAc(AC_IDENTITY);
    renderVoice(REGISTERED);
    // Single gesture: clicking the affordance.
    await startSession();
    // The pill is now live...
    const pill = document.querySelector('[data-voice-pill]');
    expect(pill).toBeTruthy();
    // ...and it shows the animated Specky avatar (visibly alive — idle loop).
    const avatar = pill!.querySelector('img');
    expect(avatar).not.toBeNull();
    expect(isAnimated(avatar)).toBe(true);
    // The inactive entry icon is gone (we're in-session now).
    expect(screen.queryByLabelText('Ask Specky')).not.toBeInTheDocument();
  });

  it('the SAME character serves both the entry doorway and the pill avatar (ac-1)', async () => {
    tagAc(AC_IDENTITY);
    renderVoice(REGISTERED);
    const entryMarkup = svgOf(screen.getByLabelText('Ask Specky').querySelector('img'));
    await startSession();
    const pillMarkup = svgOf(document.querySelector('[data-voice-pill] img'));
    // Both carry Specky's signature artwork (the clip body path + the eyes),
    // proving it's one character across both surfaces — not two different marks.
    const SIGNATURE = 'M 78 300 L 78 122';
    expect(entryMarkup).toContain(SIGNATURE);
    expect(pillMarkup).toContain(SIGNATURE);
  });

  it('where the voice guide is absent (unregistered screen), no Specky appears (ac-6)', () => {
    tagAc(AC_ABSENT_WHEN_DISABLED);
    const { container } = renderVoice(UNREGISTERED);
    // VoiceLayer renders nothing on an unregistered screen — so no affordance...
    expect(screen.queryByLabelText('Ask Specky')).not.toBeInTheDocument();
    // ...and no Specky artwork anywhere. Specky is purely the visual layer over
    // the guide; it never appears on its own.
    expect(container.querySelector('img')).toBeNull();
  });
});
