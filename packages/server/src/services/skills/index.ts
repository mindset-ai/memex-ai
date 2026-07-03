// spec-300 t-3 — public surface of the pure SKILL.md transform layer.
//
// Parse ↔ validate ↔ reconstruct, with no DB or storage dependency. Higher
// layers (upload, in-app editor, MCP update_skill / get_skill) compose these:
// parse+validate on write, reconstruct on read [dec-4, dec-11, dec-12].

export { parseSkillMd } from "./parse-skill-md.js";
export { validateSkill } from "./validate-skill.js";
export { reconstructSkillMd } from "./reconstruct-skill-md.js";
export { SkillParseError, SkillValidationError } from "./errors.js";
export type { ParsedSkill, ReconstructSkillInput } from "./types.js";

// spec-300 t-10 — the Skills SERVICE (data + transform + storage wired together)
// and its capability-flag helpers. This is the single server code path the MCP
// tools and the React UI both wrap.
export {
  createSkill,
  editSkill,
  archiveSkill,
  deleteSkill,
  restoreSkill,
  getSkill,
  getSkillFile,
  listSkills,
} from "./skills-service.js";
export type {
  CreateSkillInput,
  EditSkillInput,
  SkillFileInput,
  SkillTextFileInput,
  SkillBinaryFileInput,
  SkillView,
  SkillListItem,
  SkillFileTocEntry,
  SkillFileAccess,
} from "./skills-service.js";
export {
  normalizeCapabilities,
  DEFAULT_SKILL_CAPABILITIES,
} from "./skill-capabilities.js";
export type { SkillCapabilities } from "./skill-capabilities.js";
