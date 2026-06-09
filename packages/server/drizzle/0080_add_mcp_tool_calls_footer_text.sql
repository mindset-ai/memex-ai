-- spec-203 dec-3: footer-only audit capture.
--
-- Adds the column that stores the platform footer (everything after
-- FOOTER_DELIMITER), captured UNCONDITIONALLY by services/mcp-telemetry.ts
-- logToolCall. It never holds the full tool output — only the platform-injected
-- guidance. Nullable: NULL when a response carried no footer (non-Spec docs,
-- terse responses). Hand-migration (0009+) per packages/server/TEST.md.
ALTER TABLE "mcp_tool_calls" ADD COLUMN IF NOT EXISTS "footer_text" text;
