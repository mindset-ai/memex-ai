-- Backfill personal memexes for users whose rows predate migration 0021.
--
-- The prior migration added users.personal_account_id as nullable so existing rows could
-- roll through; this migration populates that FK for every user that doesn't yet have one,
-- creating a personal account + admin membership in the same transaction per user.
--
-- Idempotent: the WHERE clause skips users who already have a personal_account_id, so it's
-- safe to re-run. The subdomain sentinel (personal-<userId>) collides with the client-side
-- ensurePersonalAccount() helper, so if an older code path already provisioned for a user
-- the ON CONFLICT branch below will reuse that row rather than erroring.

DO $$
DECLARE
  u RECORD;
  existing_account_id uuid;
  new_account_id uuid;
BEGIN
  FOR u IN SELECT id FROM users WHERE personal_account_id IS NULL
  LOOP
    -- Reuse an existing personal account if one already exists for this user (possible
    -- if a login already lazy-provisioned one via session middleware between deploys).
    SELECT id INTO existing_account_id
    FROM accounts
    WHERE subdomain = 'personal-' || u.id::text
    LIMIT 1;

    IF existing_account_id IS NOT NULL THEN
      new_account_id := existing_account_id;
    ELSE
      INSERT INTO accounts (name, subdomain, kind)
      VALUES ('Personal Memex', 'personal-' || u.id::text, 'personal')
      RETURNING id INTO new_account_id;
    END IF;

    -- Admin membership — ON CONFLICT covers the case where the row already exists.
    INSERT INTO account_memberships (user_id, account_id, role, status)
    VALUES (u.id, new_account_id, 'administrator', 'active')
    ON CONFLICT (user_id, account_id) DO UPDATE SET role = 'administrator', status = 'active';

    UPDATE users
    SET personal_account_id = new_account_id, updated_at = now()
    WHERE id = u.id;
  END LOOP;
END $$;
