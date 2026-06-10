-- Revert spec-222 t-7 (0085_add_guide_content_surface.sql).
DROP INDEX IF EXISTS guide_content_surface_idx;
DROP INDEX IF EXISTS guide_content_surface_screen_key_idx;
ALTER TABLE guide_content DROP COLUMN IF EXISTS surface;
