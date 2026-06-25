// spec-372 issue-17 — the green "✓ <label>" pill that marks an onboarding step's done
// state, modelled on the "Connect to the Memex MCP" connected badge. It sits inline with
// the step title, right-aligned to the content (use inside a `flex justify-between` row).
export function StepDoneBadge({ label, testId }: { label: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="mt-1 inline-flex flex-none items-center gap-1 rounded-full bg-status-success-bg px-2.5 py-1 text-xs font-semibold text-status-success-text"
    >
      <span aria-hidden>✓</span> {label}
    </span>
  );
}
