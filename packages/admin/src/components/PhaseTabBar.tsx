import { useRef } from 'react';
import type { SpecStatus } from '../api/types';
import { statusVariant } from '../utils/statusStyles';

// The phase tab bar carries TWO independent visual states (spec-159 ac-2 / ac-15):
//
//   1. CURRENT PHASE — the filled pill driven by the Spec's actual phase. It
//      persists regardless of what the user has clicked. `draft` lights up a
//      dedicated grey Draft pill at the far left (NOT the Plan tab); `done`
//      lights up no tab (a "✓ Done" marker renders beside the bar instead).
//   2. SELECTED — the underline accent driven by clicks. It renders ONLY when
//      the selected tab differs from the current one (when they coincide the
//      pill alone carries the state — stacking both reads as clutter).
//      Browsing other phases never moves the current pill.
//
// A single tab can wear both at once — that's the default view (current phase
// also selected). The two states are deliberately decoupled so a user can read
// the build view while the Spec still sits in verify.
//
// DRAFT PILL — in `draft` a grey Draft pill renders leftmost, before Plan,
// carrying the current treatment (filled grey + ● dot, aria-current="step",
// data-tab="draft"). It is a status indicator, not a browsable view: it sits
// OUTSIDE the tablist's roving selection and its click selects the Plan view
// (draft's home), exactly like clicking Plan. While in draft no Plan/Build/
// Verify tab is current, so Plan may still wear the selected underline.

const TABS = ['plan', 'build', 'verify'] as const;
export type PhaseTab = (typeof TABS)[number];

const TAB_LABELS: Record<PhaseTab, string> = {
  plan: 'Plan',
  build: 'Build',
  verify: 'Verify',
};

// Per-tab fill, reusing the canonical statusVariant → status-* token classes
// (plan→warning amber, build→info blue, verify→success green). statusVariant
// already maps each phase string to its variant, so we route through it rather
// than hardcoding a second colour table.
const VARIANT_FILL: Record<ReturnType<typeof statusVariant>, string> = {
  warning: 'bg-status-warning-bg text-status-warning-text border-status-warning-border',
  info: 'bg-status-info-bg text-status-info-text border-status-info-border',
  success: 'bg-status-success-bg text-status-success-text border-status-success-border',
  danger: 'bg-status-danger-bg text-status-danger-text border-status-danger-border',
  neutral: 'bg-status-neutral-bg text-status-neutral-text border-status-neutral-border',
};

/** The Plan/Build/Verify tab a given Spec phase makes "current". `draft` and
 * `done` make NO tab current — `draft` lights up the dedicated Draft pill,
 * `done` the ✓ Done marker (the two are told apart by the `isDraft` flag, not
 * by this null). */
function currentTabFor(phase: SpecStatus): PhaseTab | null {
  switch (phase) {
    case 'plan':
      return 'plan';
    case 'build':
      return 'build';
    case 'verify':
      return 'verify';
    case 'draft':
    case 'done':
    default:
      return null;
  }
}

export interface PhaseTabBarProps {
  /** The Spec's actual phase — drives the filled "current" pill. */
  currentPhase: SpecStatus;
  /** The tab the user is browsing — drives the selected accent. */
  selectedTab: PhaseTab;
  onSelect: (tab: PhaseTab) => void;
}

export function PhaseTabBar({ currentPhase, selectedTab, onSelect }: PhaseTabBarProps) {
  const currentTab = currentTabFor(currentPhase);
  // `draft` and `done` both make no Plan/Build/Verify tab current — `isDraft`
  // tells them apart so the Draft pill and the ✓ Done marker never collide.
  const isDraft = currentPhase === 'draft';
  const tabRefs = useRef<Record<PhaseTab, HTMLButtonElement | null>>({
    plan: null,
    build: null,
    verify: null,
  });

  // Roving keyboard nav mirroring ui/Tabs conventions: Arrow keys move focus
  // and activate, Home/End jump to the ends.
  function onKeyDown(e: React.KeyboardEvent, index: number) {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = Math.min(index + 1, TABS.length - 1);
    else if (e.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0);
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const nextTab = TABS[nextIndex];
    onSelect(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  return (
    <div className="flex items-center gap-2 mb-4">
      {isDraft && (
        // Draft is the current STATUS, not a browsable view: a grey filled pill
        // outside the tablist. Clicking it selects the Plan view (draft's home),
        // matching a click on Plan. Kept out of the roving arrow-key cycle.
        <button
          type="button"
          aria-current="step"
          data-tab="draft"
          data-current="true"
          onClick={() => onSelect('plan')}
          className={`
            relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1
            text-xs font-medium uppercase tracking-wider transition-colors
            ${VARIANT_FILL.neutral}
          `}
        >
          <span aria-hidden="true" className="text-[10px] leading-none">
            ●
          </span>
          <span>Draft</span>
        </button>
      )}
      <div role="tablist" aria-label="Spec phase view" className="flex gap-2">
        {TABS.map((tab, i) => {
          const isCurrent = tab === currentTab;
          const isSelected = tab === selectedTab;
          return (
            <button
              key={tab}
              ref={(el) => {
                tabRefs.current[tab] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-current={isCurrent ? 'step' : undefined}
              data-tab={tab}
              data-current={isCurrent || undefined}
              data-selected={isSelected || undefined}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(tab)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`
                relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1
                text-xs font-medium uppercase tracking-wider transition-colors
                ${isCurrent
                  ? VARIANT_FILL[statusVariant(tab)]
                  : isSelected
                    ? 'border-transparent text-primary'
                    : 'border-transparent text-secondary hover:text-primary hover:bg-overlay'
                }
              `}
            >
              {isCurrent && (
                <span aria-hidden="true" className="text-[10px] leading-none">
                  ●
                </span>
              )}
              <span>{TAB_LABELS[tab]}</span>
              {isSelected && !isCurrent && (
                <span className="absolute -bottom-1 left-2 right-2 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      {currentTab === null && !isDraft && (
        <span
          data-testid="done-marker"
          className="inline-flex items-center gap-1 text-xs font-medium text-status-success-text"
        >
          <span aria-hidden="true">✓</span>
          Done
        </span>
      )}
    </div>
  );
}
