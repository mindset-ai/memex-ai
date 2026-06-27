// spec-366 (sol-1 of audit spec-345, umbrella spec-354): barrel for the
// per-domain tool handler modules. agent/tool-specs.ts imports the domain
// ToolSpec arrays from here and composes them into the single `toolSpecs`
// catalogue. Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.ts.
export { docsTools } from "./docs.js";
export { sectionsTools } from "./sections.js";
export { decisionsTools } from "./decisions.js";
export { acsTools } from "./acs.js";
export { tasksTools } from "./tasks.js";
export { commentsTools } from "./comments.js";
export { lifecycleTools } from "./lifecycle.js";
export { issuesTools } from "./issues.js";
export { rolesTools } from "./roles.js";
export { standardsTools } from "./standards.js";
export { facetsTools } from "./facets.js";
export { integrationsTools } from "./integrations.js";
