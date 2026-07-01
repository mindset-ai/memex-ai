-- spec-442 — Fix email-send tracking in comms_log. Two data-correctness backfills
-- plus a forward-guard constraint. All changes target the public schema.
--
-- The hand-migration runner wraps this whole file in ONE transaction and splits it
-- into statements on the breakpoint marker, so the two backfills, the constraint
-- add, and its validation are atomic: either the guard lands over clean data or
-- nothing changes. Order matters — both backfills MUST precede VALIDATE so no
-- existing row trips the new CHECK.
--
-- 1) TYPE — auth emails were mis-classified as 'transactional' (recordEmailComm's
--    default) because the magic-link / password-reset templates carried no commsType.
--    Re-type the three auth subjects to their precise taxonomy; leave every other
--    subject untouched. Idempotent — re-running maps the same subjects to the same
--    types (email_verification rows already correct since spec-12 stay put).
UPDATE "comms_log"
SET "type" = CASE "subject"
    WHEN 'Confirm your Memex.AI email' THEN 'email_verification'
    WHEN 'Your Memex.AI sign-in link' THEN 'magic_link'
    WHEN 'Reset your Memex.AI password' THEN 'password_reset'
    ELSE "type"
  END
WHERE "channel" = 'email'
  AND "subject" IN (
    'Confirm your Memex.AI email',
    'Your Memex.AI sign-in link',
    'Reset your Memex.AI password'
  );
--> statement-breakpoint

-- 2) SENT_AT — the send path stamped status='sent' but never sent_at, so every
--    historical row is sent/NULL. The true Postmark send time is unknown for these
--    (comms_event holds no Delivery event for them), so approximate with created_at
--    — a DOCUMENTED approximation: created_at is the log-write time, within moments
--    of the actual send for an immediate-fire email. Future rows carry the real
--    send time (Postmark SubmittedAt, else now()) at write time.
UPDATE "comms_log"
SET "sent_at" = "created_at"
WHERE "status" = 'sent' AND "sent_at" IS NULL;
--> statement-breakpoint

-- 3) GUARD (spec-442 dec-1, ac-7) — enforce status='sent' ⇒ sent_at IS NOT NULL going
--    forward. Added NOT VALID so the add itself takes only a brief lock; the two
--    backfills above already cleaned existing rows, so VALIDATE (next statement)
--    passes. Guarded by pg_constraint so a retry after a partial apply is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'comms_log_sent_requires_sent_at'
  ) THEN
    ALTER TABLE "comms_log"
      ADD CONSTRAINT "comms_log_sent_requires_sent_at"
      CHECK ("status" <> 'sent' OR "sent_at" IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "comms_log" VALIDATE CONSTRAINT "comms_log_sent_requires_sent_at";
