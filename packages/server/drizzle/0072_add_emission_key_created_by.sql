-- spec-129 dec-8 (t-10): record which member minted each emission key.
--
-- `created_by_user_id` powers the member-level access matrix: a member sees + revokes only
-- their OWN keys; an admin sees + revokes every key on the Memex. ON DELETE SET NULL keeps
-- the key (and its audit trail) alive if the creator's account is deleted — the key keeps
-- working and stays admin-revocable; only its member-ownership claim is dropped.
--
-- Nullable + no backfill: keys minted before this column existed (0071) have no recorded
-- creator. Those legacy keys are therefore owned-by-nobody — members never see them in
-- their own list, and only admins can revoke them. Additive change; touches one table.

ALTER TABLE memex_emission_keys
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS memex_emission_keys_created_by_user_id_idx
  ON memex_emission_keys(created_by_user_id);
