// spec-300 t-7 (dec-7 / dec-20, ac-29) — surface the active Memex's Skill
// catalogue to the agent by APPENDING it to an early tool response, the way
// `list_memexes` appends the get_information topic index (mcp/tools.ts). The
// catalogue is per-Memex, so it rides the memex-scoped early orient tool
// (`list_docs`, agent/handlers/docs.ts) rather than the cross-Memex
// `list_memexes` — one shared tool spec, so the SAME catalogue reaches BOTH the
// in-app agent and a connected coding agent (ac-29).
//
// The append is metadata only — name + description + the Memex-native capability
// flags + ref — exactly the list_skills shape (dec-10). The flags INFORM, they do
// not filter: every agent sees every Skill (dec-20). The behavioural consequence
// (the in-app agent follows what it can satisfy and hands off the rest, never
// executing code — dec-2) lives in the agent's prompt guidance (scaffold-data.ts
// SKILLS_AGENT_GUIDANCE), not here. This module only presents the catalogue.

import { listSkills } from "./skills-service.js";
import type { SkillCapabilities } from "./skill-capabilities.js";

/** Render the enabled capability flags as a compact list (or "none"). Mirrors the
 *  list_skills renderer so the catalogue append reads identically to the tool. */
function renderCapabilities(caps: SkillCapabilities): string {
  const on = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return on.length > 0 ? on.join(", ") : "none";
}

/**
 * Build the Skill-catalogue appendix for an early tool response, or `""` when the
 * Memex has no active Skills (the block only appears WHEN skills exist — dec-7).
 *
 * Format mirrors list_skills: one line per Skill with name, description, capability
 * flags, and canonical ref. A short header tells the agent skills exist and how to
 * act on them (dispatch by description; `get_skill` to load one and follow it),
 * without instructing it to go looking — it learns from the appearance (dec-7).
 * Capability-neutral because it reaches the coding agent too; the in-app-only
 * handoff behaviour is prompt guidance, not append text.
 */
export async function formatSkillCatalogueAppendix(
  memexId: string,
): Promise<string> {
  const skills = await listSkills(memexId);
  if (skills.length === 0) return "";

  const lines = skills.map((s) => {
    const caps = renderCapabilities(s.capabilities);
    return `- ${s.name} — ${s.description} | capabilities: ${caps} | ref: ${s.ref}`;
  });

  return (
    `\n\n---\nSkills available in this Memex (${skills.length}) — reusable, self-contained procedures. ` +
    `Dispatch by matching a Skill's description to the task at hand; call get_skill({ ref }) to load its ` +
    `SKILL.md and follow it as a procedure. The capability flags say what a Skill expects to touch ` +
    `(codebase-access / code-editing / external-tools).\n` +
    lines.join("\n")
  );
}
