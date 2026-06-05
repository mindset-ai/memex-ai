-- Consolidate all existing account-scoped data into a single workspace. Idempotent:
-- if everything is already in one account, this is a no-op.
--
-- Why: during multi-tenancy bootstrap (0014) we split existing data into the "Legacy"
-- account. Some environments have since grown a mix of Legacy + test accounts, and we
-- want a clean "one workspace holds everything pre-native-auth" baseline before rolling
-- the new auth stack to users.
--
-- Rules:
--   * Target account = "legacy" subdomain if present, else oldest account by created_at.
--     Bootstrap "Memex"/"memex" if no accounts exist at all.
--   * Documents' handles (doc-N) are unique per account, so moving them across accounts
--     can collide. We re-sequence incoming docs starting at (max existing handle + 1).
--   * Tasks, decisions, and doc_comments inherit via the parent doc chain — just swap
--     account_id on them too; they don't have cross-account uniqueness constraints.
--   * Memberships are NOT touched; moving content does not imply granting access.
--   * Other accounts are left in place (reversible, audit-friendly).

DO $$
DECLARE
  target_account uuid;
  max_seq integer;
  doc_row RECORD;
BEGIN
  -- 1. Resolve target account.
  SELECT id INTO target_account FROM accounts WHERE subdomain = 'legacy' LIMIT 1;

  IF target_account IS NULL THEN
    SELECT id INTO target_account FROM accounts ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF target_account IS NULL THEN
    INSERT INTO accounts (name, subdomain) VALUES ('Memex', 'memex') RETURNING id INTO target_account;
  END IF;

  -- 2. Find the highest existing doc-N in the target so we can re-sequence cleanly.
  SELECT COALESCE(
    MAX(CAST(SUBSTRING(handle FROM 'doc-([0-9]+)') AS integer)),
    0
  ) INTO max_seq
  FROM documents
  WHERE account_id = target_account;

  -- 3. Move each doc from every other account, re-numbering to avoid collisions.
  -- Iterate in created_at order so the consolidation is deterministic.
  FOR doc_row IN
    SELECT id FROM documents
    WHERE account_id <> target_account
    ORDER BY created_at ASC
  LOOP
    max_seq := max_seq + 1;
    UPDATE documents
    SET account_id = target_account,
        handle = 'doc-' || max_seq
    WHERE id = doc_row.id;
  END LOOP;

  -- 4. Update child account_ids (join through doc_id is how they're conceptually scoped,
  -- but the column is denormalised, so we sync it directly).
  UPDATE tasks        SET account_id = target_account WHERE account_id <> target_account;
  UPDATE decisions    SET account_id = target_account WHERE account_id <> target_account;
  UPDATE doc_comments SET account_id = target_account WHERE account_id <> target_account;
END $$;
