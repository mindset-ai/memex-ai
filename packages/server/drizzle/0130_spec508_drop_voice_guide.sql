-- spec-508 (dec-1 / dec-2): the voice guide is removed entirely.
-- guide_content was the voice guide's RAG store (spec-190 t-6); it had no
-- non-voice reader. onboarding_greeted_at gated the spoken first-run greeting
-- (spec-206); the greeting surface is deleted with the voice loop.
DROP TABLE IF EXISTS guide_content;
--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS onboarding_greeted_at;
