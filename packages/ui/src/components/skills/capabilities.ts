// spec-300 t-6 — shared capability-flag presentation. One source for the three
// flag keys and their human labels so the list cards, detail view, and create
// form never drift on wording.

import type { SkillCapabilities } from '../../api/skills';

export interface CapabilityChip {
  readonly key: keyof SkillCapabilities;
  readonly label: string;
  /** One-line explanation for the create-form checkboxes / chip titles. */
  readonly hint: string;
}

export const CAPABILITY_CHIPS: ReadonlyArray<CapabilityChip> = [
  {
    key: 'codebaseAccess',
    label: 'Codebase access',
    hint: 'Expects to read files in the codebase.',
  },
  {
    key: 'codeEditing',
    label: 'Code editing',
    hint: 'Expects to write or change code.',
  },
  {
    key: 'externalTools',
    label: 'External tools',
    hint: 'Expects to reach tools or services outside the repo.',
  },
];

/** The chips a skill actually claims (flag === true), in stable order. */
export function activeCapabilityChips(
  capabilities: SkillCapabilities,
): ReadonlyArray<CapabilityChip> {
  return CAPABILITY_CHIPS.filter((chip) => capabilities[chip.key]);
}
