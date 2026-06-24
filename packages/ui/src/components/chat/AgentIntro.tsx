// spec-389 t-1 (dec-1): the shared static intro card. Renders the per-mode intro
// from the AGENT_INTROS registry so every in-app agent shows the same shaped,
// no-LLM intro on an empty thread (ac-1/ac-5). One implementation, not a copy
// per surface.

import { AGENT_INTROS, type AgentChatMode } from './agentIntros';

interface AgentIntroProps {
  mode: AgentChatMode;
}

export function AgentIntro({ mode }: AgentIntroProps) {
  const intro = AGENT_INTROS[mode];
  if (!intro) return null;

  return (
    <div
      data-testid={`agent-intro-${mode}`}
      className="space-y-3 rounded-xl border border-edge bg-card/60 p-4 shadow-sm"
    >
      <p className="text-sm text-primary">{intro.lead}</p>
      <ul className="space-y-2 text-sm text-secondary">
        {intro.bullets.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true" className="text-accent">
              →
            </span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {intro.footer ? (
        <p className="border-t border-edge pt-3 text-xs text-muted">
          {intro.footer}
        </p>
      ) : null}
    </div>
  );
}
