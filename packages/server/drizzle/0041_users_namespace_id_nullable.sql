-- t-11 follow-up: relax users.namespace_id from NOT NULL to nullable.
--
-- The 0038 migration ended with `ALTER COLUMN namespace_id SET NOT NULL`
-- after backfilling, but that's stricter than the application invariant
-- needs. Insertion of a brand-new user has a chicken-and-egg with
-- `namespaces.owner_user_id`: the user row needs a namespace_id, but the
-- namespace's owner_user_id needs a user.id. The application resolves this
-- by inserting the user with namespace_id=NULL and then calling
-- `ensureUserNamespace` (services/personal-accounts.ts) to create the
-- namespace + memex pair and back-fill the FK in a transaction.
--
-- Per the original schema sketch in §3 of doc-15, namespace_id is nullable
-- ("UNIQUE so one user → one namespace") — so this aligns the DB with the
-- documented design. The invariant "every active user has a namespace" is
-- enforced at the application layer via the session middleware
-- (`if (!user.namespaceId) await ensureUserNamespace(user.id)`).

ALTER TABLE "users" ALTER COLUMN "namespace_id" DROP NOT NULL;
