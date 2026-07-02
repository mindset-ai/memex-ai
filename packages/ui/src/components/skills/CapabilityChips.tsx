// spec-300 t-6 — the capability-flag chip row shown on skill cards and the
// detail header. Renders nothing when a skill claims no capabilities.

import type { SkillCapabilities } from '../../api/skills';
import { activeCapabilityChips } from './capabilities';

export function CapabilityChips({
  capabilities,
  className = '',
}: {
  capabilities: SkillCapabilities;
  className?: string;
}) {
  const chips = activeCapabilityChips(capabilities);
  if (chips.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} data-testid="skill-capability-chips">
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.hint}
          data-capability={chip.key}
          className="inline-flex items-center rounded-full border border-edge bg-card-hover px-2 py-0.5 text-[11px] font-medium leading-none text-secondary"
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}
