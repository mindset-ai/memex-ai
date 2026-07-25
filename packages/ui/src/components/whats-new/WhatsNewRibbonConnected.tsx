// spec-200: the app-shell mount point for the What's New ribbon.
//
// Historically (spec-200 t-7) this wired the ribbon's "Ask Specky to explain"
// ear to the spec-190 voice session; spec-508 removed the voice guide, so the
// ribbon now renders without an explain affordance and this wrapper only keeps
// the mount seam stable.

import { WhatsNewRibbon } from './WhatsNewRibbon';

export function WhatsNewRibbonConnected() {
  return <WhatsNewRibbon />;
}
