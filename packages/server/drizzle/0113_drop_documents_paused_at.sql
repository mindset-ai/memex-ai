-- spec-409: remove the unused pause feature end-to-end.
--
-- documents.paused_at was added in 0037 to power a Spec "pause" lifecycle flag
-- (a "Show paused" board toggle + per-card Pause/Unpause). The feature went
-- unused, so the whole surface is removed: routes, services, MCP/list options,
-- UI controls, the Paused badge, and now the column itself.
--
-- No view or RLS policy references paused_at (only 0037, which created it), so
-- the drop is clean. IF EXISTS keeps it idempotent + safe to re-run.
ALTER TABLE documents DROP COLUMN IF EXISTS paused_at;
